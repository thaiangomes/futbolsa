import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { ClubResult, PortfolioClub, PositionView, WalletView } from "@futbolsa/contracts";
import { COMMON_ERROR_MESSAGES } from "@futbolsa/contracts";
import { type CostPosition, mulDivRound, returnBp, summarize, averagePrice } from "@futbolsa/engine";
import { Clock } from "../../../infra/clock/index.js";
import { DB, type Database, withTransaction } from "../../../infra/db/index.js";
import { clubs, positions, wallets } from "../../../infra/db/schema/index.js";
import { DomainError } from "../../../infra/http/index.js";
import { EventBus, meChannel } from "../../../infra/realtime/index.js";
import { currentSeason } from "../../admin/current-season.js";
import { auctionStates } from "../../market/state/auction-states.js";
import { EQUITY_BASE_CENTS } from "../valuation/constants.js";
import { payablesAt } from "../valuation/readers/payables-at.js";
import { pricesAt } from "../valuation/readers/prices-at.js";
import { seasons } from "../../../infra/db/schema/index.js";

export const WALLET_NOT_FOUND = "wallet_not_found";

export function clubRefOf(c: { ticker: string | null; name: string; badgeAbbr: string | null; colorPrimary: string | null; colorSecondary: string | null }): PortfolioClub {
  return { ticker: c.ticker ?? "", name: c.name, badgeAbbr: c.badgeAbbr, colorPrimary: c.colorPrimary, colorSecondary: c.colorSecondary };
}

/**
 * A carteira como o jogador a vê (`GET /portfolio`): caixa total, reservado e livre, posições, resultado por clube e
 * patrimônio. Os números saem do motor (`summarize`, `averagePrice`, `equity`, `returnBp`); o site só formata. Lê numa
 * transação só de leitura em `REPEATABLE READ` (uma foto só do banco) e aceita uma carteira qualquer, para o admin da F14.
 */
@Injectable()
export class WalletService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly clock: Clock,
    private readonly bus: EventBus,
  ) {}

  /** A carteira do usuário na temporada atual. */
  async viewForUser(userId: string): Promise<WalletView> {
    const season = await currentSeason(this.db);
    if (!season) throw new DomainError(WALLET_NOT_FOUND, 404, COMMON_ERROR_MESSAGES.not_found);
    const [wallet] = await this.db
      .select({ id: wallets.id })
      .from(wallets)
      .where(and(eq(wallets.seasonId, season.id), eq(wallets.userId, userId)));
    if (!wallet) throw new DomainError(WALLET_NOT_FOUND, 404, "Você ainda não entrou na temporada.");
    return this.view(wallet.id);
  }

  async view(walletId: number, now: Date = this.clock.now()): Promise<WalletView> {
    const [head] = await this.db.select({ userId: wallets.userId, seasonId: wallets.seasonId }).from(wallets).where(eq(wallets.id, walletId));
    if (!head) throw new DomainError(WALLET_NOT_FOUND, 404, COMMON_ERROR_MESSAGES.not_found);
    // o `seq` do canal `me` é lido ANTES do banco: um evento no meio chega de novo e a tela o aplica por cima
    const seq = head.userId ? this.bus.currentSeq(meChannel(head.userId)) : 0;

    return withTransaction(
      this.db,
      async (tx) => {
        const seasonId = head.seasonId;
        const [season] = await tx.db.select({ tradingEndedAt: seasons.tradingEndedAt }).from(seasons).where(eq(seasons.id, seasonId));
        const buybackClosed = season?.tradingEndedAt != null && season.tradingEndedAt.getTime() <= now.getTime();
        // caixa e posições do mesmo estado (a mesma foto do banco): o patrimônio de agora é o do estado atual
        const [row0] = await tx.db.select({ cash: wallets.cash, reserved: wallets.reservedCash }).from(wallets).where(eq(wallets.id, walletId));
        const balance = row0;
        if (!balance) throw new DomainError(WALLET_NOT_FOUND, 404, COMMON_ERROR_MESSAGES.not_found);

        const rows = await tx.db
          .select({
            clubId: positions.clubId,
            shares: positions.shares,
            reservedShares: positions.reservedShares,
            cost: positions.cost,
            realized: positions.realized,
            dividends: positions.dividends,
            ticker: clubs.ticker,
            name: clubs.name,
            badgeAbbr: clubs.badgeAbbr,
            colorPrimary: clubs.colorPrimary,
            colorSecondary: clubs.colorSecondary,
          })
          .from(positions)
          .innerJoin(clubs, eq(clubs.id, positions.clubId))
          .where(eq(positions.walletId, walletId));
        const prices = await pricesAt(tx, seasonId, now);
        const payables = await payablesAt(tx, seasonId, now, [walletId]);
        const auctions = await auctionStates(tx.db, seasonId);
        const receivableByClub = new Map(payables.map((p) => [p.clubId, p.amount]));
        const receivable = payables.reduce((sum, p) => sum + p.amount, 0);

        const resultsRows: ClubResult[] = [];
        const held: { row: (typeof rows)[number]; price: number; summary: ReturnType<typeof summarize>; cost: CostPosition; recv: number }[] = [];
        let stocksValue = 0;
        for (const row of rows) {
          const price = prices.get(row.clubId)?.price ?? 0;
          const cost: CostPosition = { shares: row.shares, cost: row.cost, realized: row.realized, dividends: row.dividends };
          const recv = receivableByClub.get(row.clubId) ?? 0;
          // com a recompra fechada, as ações valem R$ 0,00 e conta só o a receber da recompra
          const summary = summarize(cost, buybackClosed ? 0 : price, recv);
          resultsRows.push({
            club: clubRefOf(row),
            realized: row.realized,
            unrealized: summary.unrealized,
            dividends: row.dividends,
            receivable: recv,
            total: summary.total,
          });
          if (row.shares > 0) {
            stocksValue += summary.marketValue;
            held.push({ row, price, summary, cost, recv });
          }
        }
        // clube com a receber e sem linha de posição (não deveria existir, mas a conta fecha com o patrimônio)
        const equityNow = balance.cash + stocksValue + receivable;

        const positionViews: PositionView[] = held.map(({ row, price, summary, cost, recv }) => ({
          club: clubRefOf(row),
          shares: row.shares,
          inOrders: row.reservedShares,
          free: row.shares - row.reservedShares,
          averagePrice: averagePrice(cost),
          cost: row.cost,
          price,
          marketValue: summary.marketValue,
          unrealized: summary.unrealized,
          unrealizedPermille: summary.unrealizedPermille,
          dividends: row.dividends,
          receivable: recv,
          shareOfEquityPermille: equityNow > 0 ? mulDivRound(summary.marketValue, 1000, equityNow) : null,
          auction: auctions.get(row.ticker ?? "") ?? null,
        }));
        positionViews.sort((a, b) => b.marketValue - a.marketValue || a.club.ticker.localeCompare(b.club.ticker));
        resultsRows.sort((a, b) => b.total - a.total || a.club.ticker.localeCompare(b.club.ticker));

        return {
          seq,
          at: now.toISOString(),
          cash: { total: balance.cash, reserved: balance.reserved, free: balance.cash - balance.reserved },
          negativeCash: balance.cash < 0,
          receivable,
          stocksValue,
          equity: equityNow,
          returnBp: returnBp(equityNow, EQUITY_BASE_CENTS),
          buybackClosed,
          positions: positionViews,
          results: resultsRows,
        } satisfies WalletView;
      },
      { isolationLevel: "repeatable read", readOnly: true },
    );
  }
}
