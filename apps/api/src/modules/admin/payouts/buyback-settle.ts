import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { Clock } from "../../../infra/clock/index.js";
import { DB, type Database, type DrizzleTx, lockPayoutEvents, lockSeason, lockWallets, withTransaction } from "../../../infra/db/index.js";
import { clubs, payoutEvents, positions, wallets } from "../../../infra/db/schema/index.js";
import { PortfolioLedger, WalletEvents } from "../../portfolio/index.js";
import { dues } from "./settlement.js";

/** O que o último passo da liquidação da recompra fez. */
export interface BuybackSweep {
  eventId: number;
  /** As contas de que as ações do clube saíram sem pagamento (a tesouraria e as excluídas), em ordem de trava. */
  swept: Array<{ walletId: number; shares: number }>;
  /**
   * Por que não tirou nada: o evento não é uma recompra aprovada; a temporada encerrou; ou ainda há carteira da foto
   * sem o crédito (as ações dela saem com o crédito, e as das outras contas só depois de todas).
   */
  stopped: "not_approved" | "season_closed" | "pending_credits" | null;
}

/**
 * O último passo da liquidação da recompra (Plano do encerramento e da recompra, T4; Dividendos e recompra, critério
 * 22): depois de todas as carteiras da foto creditadas (cada uma vende as ações à casa pelo valor da recompra no lote
 * da F12, `SettleReversalService.postCredit`), tira as ações do clube de toda conta que ainda as tenha, sem pagar: a
 * tesouraria, que não recebe, e a conta excluída, cujas ações a F5 já mandou para a tesouraria (P6: não recebe nem
 * devolve). Linha `buyback` a R$ 0,00, custo `debit` (sem resultado), sem dinheiro.
 *
 * Uma transação, com as travas na ordem P3: a temporada (compartilhada), a linha do evento (`FOR SHARE`, conferindo
 * que é a recompra aprovada; a correção espera), as contas com ações do clube em ordem de id e a tesouraria por último.
 * Com elas travadas, relê as posições. Repetível: sem ações sobrando, não faz nada; o evento está liquidado quando
 * nenhuma carteira da foto tem crédito a lançar e o clube não tem mais ações em conta nenhuma (`settlingEventIds`).
 */
@Injectable()
export class BuybackSettleService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly ledger: PortfolioLedger,
    private readonly walletEvents: WalletEvents,
    private readonly clock: Clock,
  ) {}

  async sweep(eventId: number): Promise<BuybackSweep> {
    const out: BuybackSweep = { eventId, swept: [], stopped: null };
    const [event] = await this.db.select().from(payoutEvents).where(eq(payoutEvents.id, eventId));
    if (!event || event.kind !== "buyback") return { ...out, stopped: "not_approved" };

    return withTransaction(this.db, async (tx) => {
      const season = await lockSeason(tx, event.seasonId, "share");
      if (season.status === "closed") return { ...out, stopped: "season_closed" };
      const [locked] = await lockPayoutEvents(tx, [eventId], "share");
      if (locked!.status !== "approved") return { ...out, stopped: "not_approved" };
      // as carteiras da foto primeiro: enquanto falta crédito a alguma, as ações das outras contas ficam
      if ((await dues(tx, { eventId, limit: 1 })).length > 0) return { ...out, stopped: "pending_credits" };

      const holders = await this.holders(tx.db, event.seasonId, event.clubId);
      if (holders.length === 0) return out;
      await lockWallets(tx, holders.map((h) => h.walletId));
      // com as contas travadas, as ações de agora (outra execução pode ter tirado antes)
      const now = await this.holders(tx.db, event.seasonId, event.clubId, holders.map((h) => h.walletId));
      const [club] = await tx.db.select({ ticker: clubs.ticker }).from(clubs).where(eq(clubs.id, event.clubId));
      const at = this.clock.now();
      for (const h of now) {
        const result = await this.ledger.post(tx, {
          walletId: h.walletId,
          at,
          kind: "buyback",
          clubId: event.clubId,
          sharesDelta: -h.shares,
          price: 0,
          costBasis: "debit",
          ref: { type: "payout_event", id: event.id },
          reason: `${locked!.reason} (sem pagamento)`,
        });
        await this.walletEvents.posted(tx, result, club?.ticker ?? undefined);
        out.swept.push(h);
      }
      return out;
    });
  }

  /** As contas da temporada com ações do clube (a tesouraria por último, a ordem das travas). */
  private async holders(db: Database | DrizzleTx, seasonId: number, clubId: number, only?: number[]) {
    const rows = await db
      .select({ walletId: positions.walletId, shares: positions.shares, ownerType: wallets.ownerType })
      .from(positions)
      .innerJoin(wallets, eq(wallets.id, positions.walletId))
      .where(
        and(
          eq(wallets.seasonId, seasonId),
          eq(positions.clubId, clubId),
          gt(positions.shares, 0),
          ...(only ? [inArray(positions.walletId, only)] : []),
        ),
      )
      .orderBy(asc(positions.walletId));
    return rows
      .sort((a, b) => Number(a.ownerType === "treasury") - Number(b.ownerType === "treasury") || a.walletId - b.walletId)
      .map((r) => ({ walletId: r.walletId, shares: r.shares }));
  }
}
