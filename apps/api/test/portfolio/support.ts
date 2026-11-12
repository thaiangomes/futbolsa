import { and, eq } from "drizzle-orm";
import type { Database } from "../../src/infra/db/client.js";
import { lockWallets, withTransaction } from "../../src/infra/db/index.js";
import { payoutCredits, payoutEvents, payoutHoldings, seasonClubs } from "../../src/infra/db/schema/index.js";
import { post, type Movement } from "../../src/modules/portfolio/ledger/index.js";
import { insertTrade, marketSeason, tradeWallets, type MarketSeason } from "../market/helpers.js";
import { openPlayerWallets } from "../support/fixtures.js";

/** Os ajudantes dos testes da carteira e dos gráficos (F10): montar movimentos, preços e pagamentos com horário certo. */

/** Terça, 6 de abril de 2027, 15h de Brasília (a negociação abriu em 5 de abril às 10h). */
export const AFTER_OPEN = new Date("2027-04-06T18:00:00Z");

export interface PortfolioSeason extends MarketSeason {
  /** Carteiras só para os negócios que fixam o preço (os negócios de histórico precisam de duas). */
  buyer: number;
  seller: number;
}

/** A temporada de 2027 negociando, com FLA3, PAL3, SPT3 e COR3 a R$ 40,00. */
export async function portfolioSeason(db: Database, opts: Parameters<typeof marketSeason>[1] = {}): Promise<PortfolioSeason> {
  const s = await marketSeason(db, opts);
  const w = await tradeWallets(db, s.seasonId);
  return { ...s, ...w };
}

/** Aplica movimentos numa carteira (travada), no horário dado. */
export async function applyMovements(db: Database, walletId: number, at: Date, ...movements: Omit<Movement, "walletId" | "at">[]) {
  return withTransaction(db, async (tx) => {
    await lockWallets(tx, [walletId]);
    let last;
    for (const m of movements) last = await post(tx, { walletId, at, ...m });
    return last!;
  });
}

/** Um negócio de histórico que fixa o preço exibido do clube em `at` (e o `last_price`). */
export async function setPrice(db: Database, s: PortfolioSeason, ticker: string, at: Date, price: number, quantity = 1): Promise<number> {
  const clubId = s.clubIds.get(ticker)!;
  const id = await insertTrade(db, { seasonId: s.seasonId, clubId, at, price, quantity, buyerWalletId: s.buyer, sellerWalletId: s.seller });
  await db.update(seasonClubs).set({ lastPrice: price, lastTradeAt: at }).where(and(eq(seasonClubs.seasonId, s.seasonId), eq(seasonClubs.clubId, clubId)));
  return id;
}

/** Compra de IPO: `quantity` ações a `price`, saindo do caixa. */
export const ipoBuy = (clubId: number, quantity: number, price: number): Omit<Movement, "walletId" | "at"> => ({
  kind: "ipo_settle",
  clubId,
  sharesDelta: quantity,
  cashDelta: -quantity * price,
  price,
  costBasis: "purchase",
});

export const tradeBuy = (clubId: number, quantity: number, price: number): Omit<Movement, "walletId" | "at"> => ({
  kind: "trade",
  clubId,
  sharesDelta: quantity,
  cashDelta: -quantity * price,
  price,
  costBasis: "purchase",
  ref: { type: "trade", id: 1 },
});

export const tradeSell = (clubId: number, quantity: number, price: number): Omit<Movement, "walletId" | "at"> => ({
  kind: "trade",
  clubId,
  sharesDelta: -quantity,
  cashDelta: quantity * price,
  price,
  costBasis: "sale",
  ref: { type: "trade", id: 1 },
});

export async function newPlayer(db: Database, seasonId: number): Promise<number> {
  const [id] = await openPlayerWallets(db, seasonId, 1);
  return id!;
}

/** Um evento de pagamento vigente com a foto das ações de cada carteira. */
export async function insertPayout(
  db: Database,
  s: { seasonId: number; clubId: number },
  e: {
    key: string;
    perShare: number;
    closedAt: Date;
    reason?: string;
    status?: "pending" | "approved" | "superseded";
    version?: number;
    kind?: "points" | "buyback";
    holdings: [walletId: number, shares: number][];
    createdAt?: Date;
  },
): Promise<number> {
  const [row] = await db
    .insert(payoutEvents)
    .values({
      seasonId: s.seasonId,
      clubId: s.clubId,
      eventKey: e.key,
      kind: e.kind ?? "points",
      reason: e.reason ?? "3 pontos, rodada 5",
      perShare: e.perShare,
      closedAt: e.closedAt,
      status: e.status ?? "pending",
      version: e.version ?? 1,
      createdAt: e.createdAt ?? e.closedAt,
    })
    .returning({ id: payoutEvents.id });
  if (e.holdings.length > 0) await db.insert(payoutHoldings).values(e.holdings.map(([walletId, shares]) => ({ eventId: row!.id, walletId, shares })));
  return row!.id;
}

/** O crédito do pagamento no caixa: a linha `dividend` do extrato e o `payout_credits` ligado a ela. */
export async function creditPayout(db: Database, eventId: number, walletId: number, clubId: number, at: Date, amount: number, kind: "dividend" | "reversal" | "complement" = "dividend") {
  const result = await applyMovements(db, walletId, at, { kind, clubId, cashDelta: amount, ref: { type: "payout", id: eventId } });
  await db.insert(payoutCredits).values({ eventId, walletId, amount, entryId: result.entry.id });
  return result.entry.id;
}
