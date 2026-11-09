import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { postponeClose } from "@futbolsa/engine";
import { Clock } from "../../infra/clock/index.js";
import { DB, type Database, lockSeason, type SeasonRow, type Tx, withTransaction } from "../../infra/db/index.js";
import { seasons } from "../../infra/db/schema/index.js";
import { currentSeason } from "../admin/current-season.js";
import { AdminLogService } from "../admin/log/index.js";
import { ipoError } from "./errors.js";

/** O que uma passada da tarefa de fechamento fez. */
export type IpoCloseResult =
  /** Nada a fazer: sem temporada, fora de `ipo_open` (antes da abertura ou já fechada) ou antes do horário. */
  | { status: "idle" }
  /** Fechou agora: a temporada passou para `ipo_closed` e a liquidação (A5) pode rodar. */
  | { status: "closed"; seasonId: number; closedAt: Date };

/**
 * Fechar e adiar o período de ofertas do IPO (IPO por bookbuilding, critérios 14, 27 e 28; Admin, 20).
 *
 * As duas operações travam a temporada em modo exclusivo. A trava exclusiva espera as ofertas em
 * andamento (que travam em modo compartilhado) e, como toda oferta lê o relógio depois da trava, nenhuma
 * oferta validada depois do horário de fechamento é gravada. O fechamento e o adiamento também se
 * excluem: ou o fechamento vem antes (e o adiamento vê `ipo_closed`), ou o adiamento vem antes (e o
 * fechamento vê o horário novo e não fecha).
 */
@Injectable()
export class IpoClosingService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly clock: Clock,
    private readonly log: AdminLogService,
  ) {}

  /**
   * Passa a temporada para `ipo_closed` quando chega o horário de fechamento, sem ação do admin (a tarefa
   * de cada minuto, A7, chama com o relógio da API). Repetível: a segunda passada vê `ipo_closed` e não
   * faz nada; antes do horário, também não.
   */
  async closeIfDue(now: Date): Promise<IpoCloseResult> {
    const candidate = await currentSeason(this.db);
    if (!candidate) return { status: "idle" };
    return withTransaction(this.db, async (tx) => {
      // O estado lido depois da trava é o que vale: um adiamento que terminou enquanto esperávamos já
      // mudou o horário.
      const season = await lockSeason(tx, candidate.id, "update");
      if (season.status !== "ipo_open" || !season.ipoClosesAt) return { status: "idle" } as const;
      if (now.getTime() < season.ipoClosesAt.getTime()) return { status: "idle" } as const;
      await tx.db.update(seasons).set({ status: "ipo_closed" }).where(eq(seasons.id, season.id));
      // O evento `season.status` (tempo real) entra aqui com `tx.afterCommit`, na A10.
      return { status: "closed", seasonId: season.id, closedAt: season.ipoClosesAt } as const;
    });
  }

  /**
   * Adia o fechamento das ofertas para `newClosesAt`, dentro da transação de quem chama (o `PATCH
   * /admin/seasons/:id` da F7). Só com as ofertas abertas e antes do horário de fechamento atual, pelo
   * relógio lido depois da trava: antes da abertura é `ipo_not_open`; fechado (mesmo com a tarefa ainda
   * sem rodar) é `ipo_closed`; antecipar é `ipo_close_earlier`. A negociação passa a abrir às 10h de
   * Brasília do dia seguinte ao novo fechamento (critério 28). Grava no registro do admin o antes e o
   * depois (`season.ipo.postpone`, motivo aceito e não exigido). Devolve a temporada depois da mudança.
   *
   * Trava a temporada em modo exclusivo; se quem chama já travou assim, a trava se repete sem esperar.
   */
  async postponeClose(tx: Tx, seasonId: number, newClosesAt: Date, actorId: string, reason?: string): Promise<SeasonRow> {
    const season = await lockSeason(tx, seasonId, "update");
    const now = this.clock.now();
    if (season.status === "preparing") throw ipoError("ipo_not_open");
    if (
      season.status !== "ipo_open" ||
      !season.ipoOpensAt ||
      !season.ipoClosesAt ||
      !season.tradingOpensAt ||
      now.getTime() >= season.ipoClosesAt.getTime()
    ) {
      throw ipoError("ipo_closed");
    }

    let dates;
    try {
      dates = postponeClose(
        { opensAt: season.ipoOpensAt.getTime(), closesAt: season.ipoClosesAt.getTime(), tradingOpensAt: season.tradingOpensAt.getTime() },
        newClosesAt.getTime(),
        now.getTime(),
      );
    } catch (error) {
      // O motor recusa com `Error`; o período fechado já foi conferido acima, então resta antecipar.
      if (newClosesAt.getTime() < season.ipoClosesAt.getTime()) throw ipoError("ipo_close_earlier");
      throw error;
    }

    const [updated] = await tx.db
      .update(seasons)
      .set({ ipoClosesAt: new Date(dates.closesAt), tradingOpensAt: new Date(dates.tradingOpensAt) })
      .where(eq(seasons.id, seasonId))
      .returning();
    await this.log.record(tx, {
      actorId,
      action: "season.ipo.postpone",
      targetType: "season",
      targetId: String(seasonId),
      before: { ipoClosesAt: season.ipoClosesAt.toISOString(), tradingOpensAt: season.tradingOpensAt.toISOString() },
      after: { ipoClosesAt: updated!.ipoClosesAt!.toISOString(), tradingOpensAt: updated!.tradingOpensAt!.toISOString() },
      reason,
    });
    // O evento `season.status` com as datas novas (tempo real) entra aqui com `tx.afterCommit`, na A10.
    return updated!;
  }
}
