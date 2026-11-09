import "reflect-metadata";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { FixedClock } from "../../src/infra/clock/index.js";
import { clubs, ipoBids, seasonClubs, seasons, walletEntries, wallets } from "../../src/infra/db/schema/index.js";
import { DomainError } from "../../src/infra/http/index.js";
import { IpoBidsService, IpoEvents } from "../../src/modules/ipo/index.js";
import { PortfolioLedger } from "../../src/modules/portfolio/index.js";
import { useTestDatabase } from "../support/db.js";
import { INITIAL_CASH, openPlayerWallets, rng, seedSeason } from "../support/fixtures.js";
import { assertLedgerConsistent } from "../support/invariants.js";

const noEvents = { seasonStatus: () => {}, posted: () => {} } as unknown as IpoEvents;

/** Cada cenário roda 20 vezes, cada vez com carteiras novas, como os testes das travas da F4. */
const ROUNDS = 20;
/** Faixa igual para todos os clubes: piso R$ 30, teto R$ 70. */
const BAND = { bandCenter: 5000, bandFloor: 3000, bandCeiling: 7000 };

describe("ofertas do IPO sob concorrência, contra o Postgres", () => {
  const t = useTestDatabase(30);
  const clock = new FixedClock(new Date("2027-03-30T15:00:00Z"));
  let bids: IpoBidsService;
  let seasonId: number;
  let tickers: string[];

  beforeAll(async () => {
    let clubIds: Map<string, number>;
    ({ seasonId, clubIds } = await seedSeason(t.db));
    tickers = [...clubIds.keys()].sort().slice(0, 20);
    expect(tickers).toHaveLength(20);
    await t.db.insert(seasonClubs).values(tickers.map((ticker) => ({ seasonId, clubId: clubIds.get(ticker)!, division: "A", ...BAND })));
    await t.db
      .update(seasons)
      .set({ status: "ipo_open", ipoOpensAt: new Date("2027-03-28T19:00:00Z"), ipoClosesAt: new Date("2027-04-04T19:00:00Z") })
      .where(eq(seasons.id, seasonId));
    // O serviço como a aplicação monta, com o pool de conexões do arquivo: cada transação pega a sua.
    bids = new IpoBidsService(t.db, new PortfolioLedger(), clock, noEvents);
  });

  /** O código da recusa de regra; qualquer outro erro (deadlock, trava fora de ordem) faz o teste falhar. */
  const outcome = (p: Promise<unknown>): Promise<string> =>
    p.then(
      () => "ok",
      (error: unknown) => {
        if (error instanceof DomainError) return error.code;
        throw error;
      },
    );

  const walletRow = async (walletId: number) => (await t.db.select().from(wallets).where(eq(wallets.id, walletId)))[0]!;
  const reserveSum = async (walletId: number) =>
    Number(
      (
        await t.db
          .select({ total: sql<string>`coalesce(sum(${walletEntries.reservedCashDelta}), 0)` })
          .from(walletEntries)
          .where(and(eq(walletEntries.walletId, walletId), eq(walletEntries.kind, "ipo_reserve")))
      )[0]!.total,
    );

  it("1. R$ 100.000 em 20 ofertas de R$ 10.000 ao mesmo tempo: exatamente 10 passam, R$ 100.000 reservados, 10 insufficient_cash", async () => {
    const wallets = await openPlayerWallets(t.db, seasonId, ROUNDS);
    for (const walletId of wallets) {
      // 250 ações até R$ 40 = R$ 10.000 de reserva em cada clube.
      const results = await Promise.all(
        tickers.map((ticker) => outcome(bids.place(walletId, ticker, { quantity: 250, maxPrice: 4000, expect: "new" }))),
      );
      expect(results.filter((r) => r === "ok")).toHaveLength(10);
      expect(results.filter((r) => r === "insufficient_cash")).toHaveLength(10);
      expect((await walletRow(walletId)).reservedCash).toBe(INITIAL_CASH);
      expect(await reserveSum(walletId)).toBe(INITIAL_CASH);
      const active = await t.db.select().from(ipoBids).where(and(eq(ipoBids.walletId, walletId), eq(ipoBids.status, "active")));
      expect(active).toHaveLength(10);
    }
  });

  it("2. 30 PUT com valores sorteados e 10 DELETE na mesma oferta ao mesmo tempo: a reserva da carteira é a da oferta que ficou", async () => {
    const random = rng(2027);
    const wallets = await openPlayerWallets(t.db, seasonId, ROUNDS);
    const ticker = tickers[0]!;
    for (const walletId of wallets) {
      await bids.place(walletId, ticker, { quantity: 100, maxPrice: 4000, expect: "new" });
      const calls: Array<() => Promise<unknown>> = [];
      for (let i = 0; i < 30; i++) {
        // De 1 a 1.400 ações (no teto, até R$ 98.000: sempre cabe) e de R$ 30 a R$ 90 (acima do teto, a
        // reserva fica no teto); umas criando, outras editando.
        const quantity = 1 + Math.floor(random() * 1400);
        const maxPrice = 3000 + Math.floor(random() * 6000);
        const expectValue = random() < 0.5 ? "new" : "existing";
        calls.push(() => bids.place(walletId, ticker, { quantity, maxPrice, expect: expectValue }));
      }
      for (let i = 0; i < 10; i++) calls.push(() => bids.cancel(walletId, ticker));
      // Embaralha a ordem dos disparos com a mesma semente.
      for (let i = calls.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [calls[i], calls[j]] = [calls[j]!, calls[i]!];
      }
      const results = await Promise.all(calls.map((call) => outcome(call())));
      for (const r of results) expect(["ok", "bid_exists", "bid_not_found"]).toContain(r);

      const [bid] = await t.db.select().from(ipoBids).where(eq(ipoBids.walletId, walletId));
      const expected = bid!.status === "active" ? bid!.reserved : 0;
      if (bid!.status === "active") expect(bid!.reserved).toBe(bid!.quantity * Math.min(bid!.maxPrice, BAND.bandCeiling));
      else expect(bid!.reserved).toBe(0);
      expect((await walletRow(walletId)).reservedCash).toBe(expected);
      expect(await reserveSum(walletId)).toBe(expected);
    }
  });

  it("3. duas abas criando a mesma oferta (dois expect new ao mesmo tempo): uma passa, a outra bid_exists, uma reserva só", async () => {
    const wallets = await openPlayerWallets(t.db, seasonId, ROUNDS);
    const ticker = tickers[1]!;
    for (const walletId of wallets) {
      const results = await Promise.all([
        outcome(bids.place(walletId, ticker, { quantity: 1000, maxPrice: 4000, expect: "new" })),
        outcome(bids.place(walletId, ticker, { quantity: 500, maxPrice: 5000, expect: "new" })),
      ]);
      expect(results.sort()).toEqual(["bid_exists", "ok"]);
      const rows = await t.db.select().from(ipoBids).where(eq(ipoBids.walletId, walletId));
      expect(rows).toHaveLength(1);
      expect([4_000_000, 2_500_000]).toContain(rows[0]!.reserved);
      expect((await walletRow(walletId)).reservedCash).toBe(rows[0]!.reserved);
      expect(await reserveSum(walletId)).toBe(rows[0]!.reserved);
    }
  });

  it("invariantes: carteiras iguais à soma do extrato e nenhuma reserva acima do caixa", async () => {
    await assertLedgerConsistent(t.db, seasonId);
    // Nenhuma oferta de clube de fora da lista.
    const outside = await t.db
      .select({ id: ipoBids.id })
      .from(ipoBids)
      .innerJoin(clubs, eq(clubs.id, ipoBids.clubId))
      .where(sql`${clubs.ticker} not in (${sql.join(tickers.map((x) => sql`${x}`), sql`, `)})`);
    expect(outside).toHaveLength(0);
  });
});
