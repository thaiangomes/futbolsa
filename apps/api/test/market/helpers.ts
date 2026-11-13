import { eq } from "drizzle-orm";
import type { Database } from "../../src/infra/db/client.js";
import { matches, orders, seasonClubs, seasons, trades } from "../../src/infra/db/schema/index.js";
import { listClubs, openPlayerWallets, seedSeason } from "../support/fixtures.js";

/** Os clubes que os testes do mercado listam por padrão. */
export const MARKET_TICKERS = ["FLA3", "PAL3", "SPT3", "COR3"] as const;

export interface MarketSeason {
  seasonId: number;
  clubIds: Map<string, number>;
}

/**
 * Uma temporada de 2027 com os clubes listados (preço exibido de R$ 40,00, `ipo_price` igual) e a negociação aberta
 * (`status: trading`, abertura em 2027-04-05 às 10h de Brasília). Cada teste ajusta o resto.
 */
export async function marketSeason(
  db: Database,
  opts: { tickers?: readonly string[]; totalShares?: number; status?: string; tradingOpensAt?: Date } = {},
): Promise<MarketSeason> {
  const { seasonId, clubIds } = await seedSeason(db);
  await listClubs(db, seasonId, clubIds, opts.tickers ?? MARKET_TICKERS, opts.totalShares ?? 3000);
  await db.update(seasonClubs).set({ ipoPrice: 4000 }).where(eq(seasonClubs.seasonId, seasonId));
  await db
    .update(seasons)
    .set({ status: opts.status ?? "trading", tradingOpensAt: opts.tradingOpensAt ?? new Date("2027-04-05T13:00:00Z") })
    .where(eq(seasons.id, seasonId));
  return { seasonId, clubIds };
}

/**
 * Grava um negócio já pronto (histórico), com duas ordens executadas de carteiras de jogadores, sem passar pelo
 * motor: serve a testes que só leem o histórico. Não mexe em `last_price`.
 */
export async function insertTrade(
  db: Database,
  t: { seasonId: number; clubId: number; at: Date; price: number; quantity: number; buyerWalletId: number; sellerWalletId: number; inAuction?: boolean; priceBefore?: number; withHouse?: boolean },
): Promise<number> {
  const base = { seasonId: t.seasonId, clubId: t.clubId, type: "limit", quantity: t.quantity, filled: t.quantity, limitPrice: t.price, status: "filled", createdAt: t.at, updatedAt: t.at };
  const [buy] = await db.insert(orders).values({ ...base, walletId: t.buyerWalletId, side: "buy" }).returning({ id: orders.id });
  const [sell] = await db.insert(orders).values({ ...base, walletId: t.sellerWalletId, side: "sell" }).returning({ id: orders.id });
  const [row] = await db
    .insert(trades)
    .values({
      seasonId: t.seasonId,
      clubId: t.clubId,
      at: t.at,
      price: t.price,
      quantity: t.quantity,
      buyOrderId: buy!.id,
      sellOrderId: sell!.id,
      buyerWalletId: t.buyerWalletId,
      sellerWalletId: t.sellerWalletId,
      priceBefore: t.priceBefore ?? t.price,
      withHouse: t.withHouse ?? false,
      inAuction: t.inAuction ?? false,
    })
    .returning({ id: trades.id });
  return row!.id;
}

/** Duas carteiras de jogadores para os negócios de histórico. */
export async function tradeWallets(db: Database, seasonId: number): Promise<{ buyer: number; seller: number }> {
  const [buyer, seller] = await openPlayerWallets(db, seasonId, 2);
  return { buyer: buyer!, seller: seller! };
}

/** Um jogo do Brasileirão entre dois clubes. */
export async function insertMatch(
  db: Database,
  m: { seasonId: number; homeClubId: number; awayClubId: number; kickoff: Date; status?: string; round?: number },
): Promise<number> {
  const [row] = await db
    .insert(matches)
    .values({
      seasonId: m.seasonId,
      competition: "brasileirao-a",
      round: m.round ?? 1,
      homeClubId: m.homeClubId,
      awayClubId: m.awayClubId,
      kickoff: m.kickoff,
      status: m.status ?? "scheduled",
    })
    .returning({ id: matches.id });
  return row!.id;
}

/** Uma ordem limitada aberta já pronta no livro (sem reserva nem extrato): serve a testes que só leem o livro. */
export async function insertOpenOrder(
  db: Database,
  o: { seasonId: number; clubId: number; walletId: number; side: "buy" | "sell"; price: number; quantity: number; filled?: number; at?: Date },
): Promise<number> {
  const at = o.at ?? new Date("2027-04-05T13:00:00Z");
  const [row] = await db
    .insert(orders)
    .values({
      seasonId: o.seasonId,
      clubId: o.clubId,
      walletId: o.walletId,
      side: o.side,
      type: "limit",
      quantity: o.quantity,
      filled: o.filled ?? 0,
      limitPrice: o.price,
      status: "open",
      createdAt: at,
      updatedAt: at,
    })
    .returning({ id: orders.id });
  return row!.id;
}
