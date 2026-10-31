import { eq, inArray } from "drizzle-orm";
import type { Database } from "../../src/infra/db/client.js";
import { seed } from "../../src/infra/db/seed.js";
import { clubs, seasonClubs, seasons, users } from "../../src/infra/db/schema/index.js";
import { withTransaction } from "../../src/infra/db/transaction.js";
import { openWallet, type WalletOwner } from "../../src/modules/portfolio/ledger/index.js";

export const T0 = new Date("2027-04-01T13:00:00Z");

/** R$ 100.000,00 em centavos. */
export const INITIAL_CASH = 10_000_000;

/** Os clubes e a temporada do seed; devolve a temporada e o id de cada ticker. */
export async function seedSeason(db: Database, year = 2027): Promise<{ seasonId: number; clubIds: Map<string, number> }> {
  await seed(db, year);
  const [season] = await db.select().from(seasons).where(eq(seasons.year, year));
  const rows = await db.select({ id: clubs.id, ticker: clubs.ticker }).from(clubs);
  return { seasonId: season!.id, clubIds: new Map(rows.map((r) => [r.ticker!, r.id])) };
}

/** Lista os clubes na temporada (Série A), com as ações totais dadas. */
export async function listClubs(
  db: Database,
  seasonId: number,
  clubIds: Map<string, number>,
  tickers: readonly string[],
  totalShares = 0,
): Promise<void> {
  await db.insert(seasonClubs).values(
    tickers.map((t) => ({ seasonId, clubId: clubIds.get(t)!, division: "A", totalShares, lastPrice: 4000 })),
  );
}

let userCounter = 0;

export async function createUser(db: Database): Promise<string> {
  userCounter++;
  const [user] = await db
    .insert(users)
    .values({ email: `jogador${userCounter}_${Date.now()}@exemplo.com`, nickname: `jogador_${userCounter}_${Date.now() % 100000}` })
    .returning({ id: users.id });
  return user!.id;
}

/** Abre carteiras numa transação só e devolve os ids, na ordem pedida. */
export async function openWallets(
  db: Database,
  seasonId: number,
  owners: WalletOwner[],
  initialCash = INITIAL_CASH,
): Promise<number[]> {
  return withTransaction(db, async (tx) => {
    const ids: number[] = [];
    for (const owner of owners) {
      const w = await openWallet(tx, {
        seasonId,
        owner,
        at: T0,
        entryMode: owner.type === "user" ? "ipo" : undefined,
        initialCash: owner.type === "treasury" ? 0 : initialCash,
      });
      ids.push(w.id);
    }
    return ids;
  });
}

/** Carteiras de jogadores novos. */
export async function openPlayerWallets(db: Database, seasonId: number, count: number, initialCash = INITIAL_CASH) {
  const owners: WalletOwner[] = [];
  for (let i = 0; i < count; i++) owners.push({ type: "user", userId: await createUser(db) });
  return openWallets(db, seasonId, owners, initialCash);
}

export async function clubIdsOf(db: Database, tickers: string[]): Promise<number[]> {
  const rows = await db.select().from(clubs).where(inArray(clubs.ticker, tickers));
  return tickers.map((t) => rows.find((r) => r.ticker === t)!.id);
}

/** Uma promessa resolvida por fora, para sincronizar transações concorrentes. */
export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sorteio com semente (mulberry32), para os testes de concorrência se repetirem. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
