import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Cents } from "@futbolsa/engine";
import { Clock } from "../../../infra/clock/index.js";
import { DB, type Database } from "../../../infra/db/index.js";
import { clubs, marketRefreshRequests, matches, seasonClubs } from "../../../infra/db/schema/index.js";
import { currentSeason } from "../../admin/current-season.js";
import { clubsInMatch } from "../state/match-mode.js";
import { FairValueService } from "./fair-value.service.js";
import { lastDueRefresh, needsRefresh } from "./refresh-schedule.js";
import { RefreshService, RefreshWaker, type RefreshWakeUp } from "./refresh.service.js";

/** O que uma passada da reposição fez: quem foi reposto, quem estava suspenso ou ficou para trás, e quem deu erro. */
export interface RefreshReport {
  /** `true` quando a passada anterior ainda rodava ou a negociação não está aberta: nada foi feito. */
  skipped: boolean;
  refreshed: string[];
  /** O clube estava suspenso (ou a reposição foi pulada pela porta do horário): continua devendo. */
  waiting: string[];
  failed: { ticker: string; error: string }[];
}

/**
 * A tarefa da reposição da casa (T11 do Plano do livro de ofertas e formador; "Agenda da reposição"). A cada minuto
 * olha cada clube e repõe os que estão atrasados: a última reposição devida (as horas de 3 em 3 horas de Brasília, a
 * estreia e o início do último jogo que já começou, `lastDueRefresh`) é posterior à última feita (`mm_refreshed_at`),
 * ou há um pedido aberto em `market_refresh_requests` (placar importado ou corrigido, fechamento, retomada).
 *
 * - **Nunca antes da hora:** a agenda é calculada, não uma fila: reiniciar a API não repõe antes do horário seguinte e
 *   a API fora por horas repõe uma vez ao voltar, não várias.
 * - **Na mesma hora (P5):** quem grava um pedido acorda a reposição depois do `COMMIT` (`RefreshWaker`), sem esperar o
 *   minuto seguinte; é como a retomada de uma suspensão cota na mesma hora (critério 32).
 * - Cada clube é uma transação; um que falha não segura os outros. O valor justo de todos sai de uma conta só por
 *   passada, fora das travas. Clube ou mercado suspenso não é reposto e o pedido fica aberto até a retomada.
 */
@Injectable()
export class RefreshJob implements OnModuleInit {
  private readonly logger = new Logger("Reposição");
  private running = false;

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly refresh: RefreshService,
    private readonly fairValues: FairValueService,
    private readonly waker: RefreshWaker,
    private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.waker.onWake((request) => void this.runRequested(request).catch((error: unknown) => this.logger.error(`reposição pedida falhou: ${(error as Error).message}`)));
  }

  /** Uma passada por horário: repõe os clubes atrasados e os que têm pedido aberto. */
  async runDue(now: Date = this.clock.now()): Promise<RefreshReport> {
    if (this.running) return { skipped: true, refreshed: [], waiting: [], failed: [] };
    this.running = true;
    try {
      const season = await currentSeason(this.db);
      if (!season || season.status !== "trading" || season.tradingOpensAt === null || now < season.tradingOpensAt) {
        return { skipped: true, refreshed: [], waiting: [], failed: [] };
      }
      const rows = await this.db
        .select({ clubId: seasonClubs.clubId, ticker: clubs.ticker, mmRefreshedAt: seasonClubs.mmRefreshedAt, suspendedReason: seasonClubs.suspendedReason })
        .from(seasonClubs)
        .innerJoin(clubs, eq(clubs.id, seasonClubs.clubId))
        .where(eq(seasonClubs.seasonId, season.id));
      const kickoffs = await this.kickoffs(season.id);
      const pending = new Set(
        (await this.db.select({ clubId: marketRefreshRequests.clubId }).from(marketRefreshRequests).where(and(eq(marketRefreshRequests.seasonId, season.id), isNull(marketRefreshRequests.doneAt)))).map((r) => r.clubId),
      );
      const late = rows.filter((r) =>
        needsRefresh({
          refreshedAt: r.mmRefreshedAt,
          due: lastDueRefresh({ now, opensAt: season.tradingOpensAt, kickoffs: kickoffs.get(r.clubId) ?? [] }),
          pendingRequest: pending.has(r.clubId),
        }),
      );
      const report: RefreshReport = { skipped: false, refreshed: [], waiting: [], failed: [] };
      const active = late.filter((r) => {
        const suspended = r.suspendedReason !== null || season.suspendedReason !== null;
        if (suspended) report.waiting.push(r.ticker!);
        return !suspended;
      });
      await this.refreshClubs(season.id, active.map((r) => ({ clubId: r.clubId, ticker: r.ticker! })), now, report);
      return report;
    } finally {
      this.running = false;
    }
  }

  /** Repõe já os clubes de um pedido (o despertar do P5), sem esperar a passada do minuto. */
  async runRequested(request: Pick<RefreshWakeUp, "seasonId" | "tickers">, now: Date = this.clock.now()): Promise<RefreshReport> {
    const season = await currentSeason(this.db);
    const report: RefreshReport = { skipped: false, refreshed: [], waiting: [], failed: [] };
    if (!season || season.id !== request.seasonId || season.status !== "trading") return { ...report, skipped: true };
    const rows = await this.db
      .select({ clubId: seasonClubs.clubId, ticker: clubs.ticker, suspendedReason: seasonClubs.suspendedReason })
      .from(seasonClubs)
      .innerJoin(clubs, eq(clubs.id, seasonClubs.clubId))
      .where(eq(seasonClubs.seasonId, season.id));
    const wanted = rows.filter((r) => request.tickers.includes(r.ticker!));
    const ok = wanted.filter((r) => r.suspendedReason === null && season.suspendedReason === null);
    for (const r of wanted) if (!ok.includes(r)) report.waiting.push(r.ticker!);
    await this.refreshClubs(season.id, ok.map((r) => ({ clubId: r.clubId, ticker: r.ticker! })), now, report);
    return report;
  }

  private async refreshClubs(seasonId: number, list: { clubId: number; ticker: string }[], now: Date, report: RefreshReport): Promise<void> {
    if (list.length === 0) return;
    let fair: Map<string, Cents>;
    try {
      fair = await this.fairValues.compute(seasonId, now);
    } catch (error) {
      // sem valor justo (calendário ainda não importado, copa sem tabela): ninguém é reposto, e a próxima passada tenta de novo
      const message = (error as Error).message;
      this.logger.error(`valor justo indisponível: ${message}`);
      for (const c of list) report.failed.push({ ticker: c.ticker, error: message });
      return;
    }
    const playing = new Set(await clubsInMatch(this.db, seasonId, now));
    for (const c of list) {
      try {
        const result = await this.refresh.refreshClub(seasonId, c.ticker, now, { fairValues: fair, inMatch: playing.has(c.clubId) });
        (result.refreshed ? report.refreshed : report.waiting).push(c.ticker);
      } catch (error) {
        const message = (error as Error).message;
        this.logger.error(`reposição de ${c.ticker} falhou: ${message}`);
        report.failed.push({ ticker: c.ticker, error: message });
      }
    }
  }

  /** Os inícios dos jogos de cada clube que valem para a agenda: marcados ou já encerrados (adiado e cancelado não ligam o modo de jogo nem a reposição). */
  private async kickoffs(seasonId: number): Promise<Map<number, Date[]>> {
    const rows = await this.db
      .select({ home: matches.homeClubId, away: matches.awayClubId, kickoff: matches.kickoff })
      .from(matches)
      .where(and(eq(matches.seasonId, seasonId), inArray(matches.status, ["scheduled", "finished"])));
    const byClub = new Map<number, Date[]>();
    for (const m of rows) for (const id of [m.home, m.away]) byClub.set(id, [...(byClub.get(id) ?? []), m.kickoff]);
    return byClub;
  }
}
