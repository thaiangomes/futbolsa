import "reflect-metadata";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { CLUBS } from "@futbolsa/engine/data/clubs";
import type { Database } from "../../src/infra/db/index.js";
import { lockWallets, withTransaction } from "../../src/infra/db/index.js";
import { clubs, ipoResults, matches, seasonClubs, seasons } from "../../src/infra/db/schema/index.js";
import { post } from "../../src/modules/portfolio/ledger/index.js";
import { createAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { type TestDatabase, useTestDatabase } from "../support/db.js";
import { openWallets, seedSeason, T0 } from "../support/fixtures.js";
import { FixedClock } from "../../src/infra/clock/index.js";
import { EntryService } from "../../src/modules/entry/enter.service.js";
import type { EntryOwner } from "../../src/modules/entry/availability.js";

/** Ações de cada clube que a tesouraria guarda no começo (o que o IPO deixou para a casa). */
export const TREASURY_SHARES = 1_000;

export interface EntryWorldOptions {
  /** Quantos clubes listar; o padrão é 20, os do cadastro. Acima disso entram clubes extras (`ZAA3`, `ZAB3`...). */
  clubs?: number;
  /** Preço de referência de todos (centavos) ou por ticker. O padrão é R$ 24,00. */
  prices?: number | Record<string, number>;
  /** Estado da temporada; o padrão é `trading`. */
  status?: string;
  /** Com `false`, o IPO não liquidou (`ipo_results` vazio). */
  settled?: boolean;
  /** Com `false`, o preço vem só do IPO (`last_price` nulo). */
  traded?: boolean;
  /** Ações emitidas por clube, todas na tesouraria. */
  totalShares?: number;
}

export interface EntryWorld {
  seasonId: number;
  clubIds: Map<string, number>;
  tickers: string[];
  treasuryId: number;
}

/**
 * A temporada num estado de entrada no meio: clubes listados com preço e ações na tesouraria, IPO liquidado,
 * negociação aberta e a Série A com um jogo ainda por disputar (a janela aberta). Use `closeWindow` para fechá-la.
 */
export async function entryWorld(db: Database, o: EntryWorldOptions = {}): Promise<EntryWorld> {
  const { seasonId, clubIds } = await seedSeason(db, 2027);
  const want = o.clubs ?? 20;
  const tickers = typeof o.prices === "object" ? Object.keys(o.prices) : CLUBS.slice(0, want).map((c) => c.id);
  for (let i = 0; tickers.length < want && typeof o.prices !== "object"; i++) {
    const ticker = `Z${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}3`;
    const [row] = await db.insert(clubs).values({ ticker, name: `Clube extra ${ticker}` }).returning({ id: clubs.id });
    clubIds.set(ticker, row!.id);
    tickers.push(ticker);
  }
  const priceOf = (t: string) => (typeof o.prices === "object" ? o.prices[t]! : (o.prices ?? 2400));
  const total = o.totalShares ?? TREASURY_SHARES;
  await db.insert(seasonClubs).values(
    tickers.map((t) => ({
      seasonId,
      clubId: clubIds.get(t)!,
      division: "A",
      totalShares: total,
      ipoPrice: priceOf(t),
      lastPrice: o.traded === false ? null : priceOf(t),
      lastTradeAt: o.traded === false ? null : T0,
    })),
  );
  if (o.settled !== false) {
    await db.insert(ipoResults).values(
      tickers.map((t) => ({
        seasonId,
        clubId: clubIds.get(t)!,
        cutPrice: priceOf(t),
        demandAtCut: 1,
        allocationNum: 1,
        allocationDen: 1,
        treasuryShares: total,
        mmLotShares: 0,
        settledAt: T0,
      })),
    );
  }
  await db
    .update(seasons)
    .set({ status: o.status ?? "trading", tradingOpensAt: new Date("2027-03-31T13:00:00Z") })
    .where(eq(seasons.id, seasonId));
  const [treasuryId] = await openWallets(db, seasonId, [{ type: "treasury" }], 0);
  await withTransaction(db, async (tx) => {
    await lockWallets(tx, [treasuryId!]);
    for (const t of tickers) {
      await post(tx, {
        walletId: treasuryId!,
        at: T0,
        kind: "ipo_settle",
        clubId: clubIds.get(t)!,
        sharesDelta: total,
        price: priceOf(t),
        costBasis: "purchase",
      });
    }
  });
  // a Série A: uma rodada jogada e outra por disputar
  const fla = clubIds.get("FLA3")!;
  const pal = clubIds.get("PAL3")!;
  await db.insert(matches).values([
    { seasonId, competition: "brasileirao-a", round: 1, homeClubId: fla, awayClubId: pal, kickoff: new Date("2027-03-30T22:00:00Z"), finishedAt: new Date("2027-03-31T00:00:00Z"), homeGoals: 1, awayGoals: 0, status: "finished" },
    { seasonId, competition: "brasileirao-a", round: 2, homeClubId: pal, awayClubId: fla, kickoff: new Date("2027-12-01T22:00:00Z"), status: "scheduled" },
  ]);
  return { seasonId, clubIds, tickers, treasuryId: treasuryId! };
}

/** Encerra o último jogo da Série A: a janela da entrada fecha no fim dele (devolve o instante). */
export async function closeWindow(db: Database, seasonId: number): Promise<Date> {
  const finishedAt = new Date("2027-12-02T00:00:00Z");
  await db
    .update(matches)
    .set({ status: "finished", homeGoals: 2, awayGoals: 2, finishedAt })
    .where(and(eq(matches.seasonId, seasonId), eq(matches.round, 2)));
  return finishedAt;
}

/** Reabre o último jogo (a janela volta a abrir). */
export async function reopenWindow(db: Database, seasonId: number): Promise<void> {
  await db
    .update(matches)
    .set({ status: "scheduled", homeGoals: null, awayGoals: null, finishedAt: null })
    .where(and(eq(matches.seasonId, seasonId), eq(matches.round, 2)));
}

/** Quem entra: um jogador novo, ativo, sem carteira. */
export type NewOwner = () => Promise<EntryOwner>;

export interface EntryApp {
  readonly app: NestFastifyApplication;
  readonly db: Database;
  readonly conn: TestDatabase;
  readonly clock: FixedClock;
  readonly world: EntryWorld;
  readonly service: EntryService;
  readonly newOwner: NewOwner;
}

/**
 * A API inteira sobre um banco só do arquivo (ou do `describe`) com o mundo da entrada pronto. Chame dentro de um
 * `describe`: os ganchos `beforeAll` e `afterAll` ficam no escopo dele.
 */
export function useEntryApp(options: EntryWorldOptions & { poolSize?: number; clockAt?: Date } = {}): EntryApp {
  const database = useTestDatabase(options.poolSize ?? 10);
  const clock = new FixedClock(options.clockAt ?? T0);
  let app: NestFastifyApplication;
  let world: EntryWorld;
  beforeAll(async () => {
    world = await entryWorld(database.db, options);
    app = await createTestApp({ db: database.db, clock });
  });
  afterAll(() => app?.close());
  return {
    get app() {
      return app;
    },
    get db() {
      return database.db;
    },
    get conn() {
      return database.conn;
    },
    clock,
    get world() {
      return world;
    },
    get service() {
      return app.get(EntryService);
    },
    newOwner: async () => {
      const account = await createAccount(database.db);
      return { type: "user", userId: account.id, status: "active" };
    },
  } as EntryApp;
}
