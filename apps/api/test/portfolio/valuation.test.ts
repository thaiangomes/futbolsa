import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { lockWallets, withTransaction } from "../../src/infra/db/index.js";
import { seasons, walletEntries, wallets } from "../../src/infra/db/schema/index.js";
import { EquityAt } from "../../src/modules/portfolio/valuation/equity-at.js";
import { useTestDatabase } from "../support/db.js";
import { rng } from "../support/fixtures.js";
import { applyMovements, creditPayout, insertPayout, ipoBuy, newPlayer, portfolioSeason, setPrice, tradeBuy, tradeSell, type PortfolioSeason } from "./support.js";

// T4 do Plano da carteira e gráficos: o patrimônio num instante (`EquityAt`), a mesma conta da carteira, do ponto
// diário, da foto mensal e dos rankings (critérios 9, 10, 13, 14, 17 e 38 da Carteira e gráficos).

const at = (iso: string) => new Date(iso);
const D5 = at("2027-04-05T14:00:00Z");
const D6a = at("2027-04-06T13:00:00Z");
const D6b = at("2027-04-06T16:00:00Z");

describe("valuation: patrimônio num instante", () => {
  const database = useTestDatabase(8);
  let s: PortfolioSeason;
  let fla: number;
  let pal: number;

  beforeAll(async () => {
    s = await portfolioSeason(database.db);
    fla = s.clubIds.get("FLA3")!;
    pal = s.clubIds.get("PAL3")!;
  });

  const equityOf = (walletId: number, when: Date) =>
    withTransaction(database.db, async (tx) => (await EquityAt.forSeason(tx, s.seasonId, when, { wallets: [walletId] })).get(walletId));

  it("carteira 13: R$ 58.000 de caixa e 1.200 ações a R$ 45,00 valem R$ 112.000,00 (+12%); antes da venda, R$ 106.000,00", async () => {
    const w = await newPlayer(database.db, s.seasonId);
    await applyMovements(database.db, w, D5, ipoBuy(fla, 1000, 3500));
    await setPrice(database.db, s, "FLA3", D5, 3500);
    await applyMovements(database.db, w, D6a, tradeBuy(fla, 500, 4100));
    await setPrice(database.db, s, "FLA3", D6a, 4100);
    await applyMovements(database.db, w, D6b, tradeSell(fla, 300, 4500));
    await setPrice(database.db, s, "FLA3", D6b, 4500);

    const now = await equityOf(w, at("2027-04-06T20:00:00Z"));
    expect(now).toMatchObject({ cash: 5_800_000, receivable: 0, equity: 11_200_000 });
    expect(now!.positions).toEqual([{ clubId: fla, ticker: "FLA3", shares: 1200, price: 4500 }]);

    // um instante antes da venda: o preço é o do último negócio até ali (R$ 41,00), e a venda não entra
    const before = await equityOf(w, at("2027-04-06T15:00:00Z"));
    expect(before).toMatchObject({ cash: 4_450_000, equity: 4_450_000 + 1500 * 4100 });
    expect(before!.positions[0]).toMatchObject({ shares: 1500, price: 4100 });
  });

  it("carteira 10 e 16: clube sem negócio vale o preço do IPO e quem só tem caixa tem R$ 100.000,00", async () => {
    const w = await newPlayer(database.db, s.seasonId);
    const cashOnly = await equityOf(w, AFTER_OPEN_ISO);
    expect(cashOnly).toMatchObject({ cash: 10_000_000, equity: 10_000_000, positions: [] });
    await applyMovements(database.db, w, AFTER_OPEN_ISO, ipoBuy(pal, 100, 4000));
    expect((await equityOf(w, AFTER_OPEN_ISO))!.equity).toBe(10_000_000);
  });

  it("a carteira que entrou depois de T não existe em T", async () => {
    const w = await newPlayer(database.db, s.seasonId);
    await database.db.update(wallets).set({ enteredAt: at("2027-04-10T13:00:00Z") }).where(eq(wallets.id, w));
    expect(await equityOf(w, at("2027-04-09T13:00:00Z"))).toBeUndefined();
    expect(await equityOf(w, at("2027-04-10T13:00:00Z"))).toBeDefined();
  });

  it("carteira 17: o caixa negativo por estorno soma no patrimônio", async () => {
    const w = await newPlayer(database.db, s.seasonId);
    await applyMovements(database.db, w, AFTER_OPEN_ISO, { kind: "reversal", clubId: fla, cashDelta: -10_025_000, reason: "estorno" });
    expect(await equityOf(w, AFTER_OPEN_ISO)).toMatchObject({ cash: -25_000, equity: -25_000 });
  });

  it("carteira 38: R$ 360,00 a receber contam no patrimônio e, ao cair no caixa, o patrimônio não muda", async () => {
    const w = await newPlayer(database.db, s.seasonId);
    await applyMovements(database.db, w, D5, ipoBuy(pal, 1200, 4000));
    const eventId = await insertPayout(database.db, { seasonId: s.seasonId, clubId: pal }, { key: "pts-r5", perShare: 30, closedAt: at("2027-04-06T12:00:00Z"), holdings: [[w, 1200]] });
    const pending = await equityOf(w, AFTER_OPEN_ISO);
    expect(pending).toMatchObject({ receivable: 36_000, equity: 10_000_000 + 36_000 });
    expect(pending!.receivableByClub.get(pal)).toBe(36_000);
    // antes do fechamento do evento, nada a receber
    expect((await equityOf(w, at("2027-04-06T11:00:00Z")))!.receivable).toBe(0);

    await creditPayout(database.db, eventId, w, pal, at("2027-04-06T19:00:00Z"), 36_000);
    const paid = await equityOf(w, at("2027-04-06T20:00:00Z"));
    expect(paid).toMatchObject({ receivable: 0, cash: 10_000_000 - 4_800_000 + 36_000, equity: 10_000_000 + 36_000 });
    // e em T anterior ao crédito, ainda a receber (o crédito é "ponta" e sai)
    expect((await equityOf(w, at("2027-04-06T18:30:00Z")))!.receivable).toBe(36_000);
  });

  it("evento corrigido usa a versão atual e o que já foi pago por qualquer versão", async () => {
    const w = await newPlayer(database.db, s.seasonId);
    await applyMovements(database.db, w, D5, ipoBuy(pal, 100, 4000));
    const v1 = await insertPayout(database.db, { seasonId: s.seasonId, clubId: pal }, { key: "pts-r6", perShare: 30, closedAt: at("2027-04-06T10:00:00Z"), status: "superseded", holdings: [[w, 100]] });
    await creditPayout(database.db, v1, w, pal, at("2027-04-06T11:00:00Z"), 3000);
    await insertPayout(database.db, { seasonId: s.seasonId, clubId: pal }, { key: "pts-r6", perShare: 50, closedAt: at("2027-04-06T10:00:00Z"), version: 2, holdings: [[w, 100]], createdAt: at("2027-04-06T12:00:00Z") });
    // versão atual R$ 0,50 × 100 = R$ 50,00, já pagos R$ 30,00: a receber R$ 20,00
    expect((await equityOf(w, at("2027-04-06T14:00:00Z")))!.receivable).toBe(2000);
  });

  it("com a recompra fechada, as ações valem R$ 0,00 e conta só a recompra a receber", async () => {
    const w = await newPlayer(database.db, s.seasonId);
    await applyMovements(database.db, w, D5, ipoBuy(pal, 100, 4000));
    await insertPayout(database.db, { seasonId: s.seasonId, clubId: pal }, { key: "buyback", kind: "buyback", perShare: 1935, closedAt: at("2027-04-20T12:00:00Z"), holdings: [[w, 100]] });
    await database.db.update(seasons).set({ tradingEndedAt: at("2027-04-20T12:00:00Z") }).where(eq(seasons.id, s.seasonId));
    const closed = await equityOf(w, at("2027-04-21T12:00:00Z"));
    expect(closed).toMatchObject({ buybackClosed: true, receivable: 193_500, equity: 10_000_000 - 400_000 + 193_500 });
    const open = await equityOf(w, at("2027-04-19T12:00:00Z"));
    expect(open).toMatchObject({ buybackClosed: false, receivable: 0 });
    await database.db.update(seasons).set({ tradingEndedAt: null }).where(eq(seasons.id, s.seasonId));
  });

  it("a linha season_close sempre conta como depois: o patrimônio de T não zera", async () => {
    const w = await newPlayer(database.db, s.seasonId);
    await applyMovements(database.db, w, D5, ipoBuy(fla, 100, 4000));
    const before = await equityOf(w, at("2027-04-30T12:00:00Z"));
    await applyMovements(database.db, w, at("2027-04-25T12:00:00Z"), { kind: "season_close", clubId: fla, sharesDelta: -100, costBasis: "debit", cashDelta: -9_600_000 });
    const [row] = await database.db.select().from(wallets).where(eq(wallets.id, w));
    expect(row!.cash).toBe(0);
    expect(await equityOf(w, at("2027-04-30T12:00:00Z"))).toMatchObject({ cash: before!.cash, equity: before!.equity });
  });

  it("a função termina com o conjunto de uma conexão só e as carteiras travadas pelo chamador (não abre conexão nem transação)", async () => {
    const w = await newPlayer(database.db, s.seasonId);
    // dentro de UMA transação, com a carteira travada; se a função pedisse outra conexão ao conjunto, o teste travava
    await withTransaction(database.db, async (tx) => {
      await lockWallets(tx, [w]);
      const result = await EquityAt.forSeason(tx, s.seasonId, AFTER_OPEN_ISO, { wallets: [w] });
      expect(result.get(w)!.equity).toBe(10_000_000);
    });
  });

  it("o número de consultas é o mesmo com 1 e com 30 carteiras", async () => {
    const many = [];
    for (let i = 0; i < 30; i++) many.push(await newPlayer(database.db, s.seasonId));
    const count = async (ids: number[]) =>
      withTransaction(database.db, async (tx) => {
        const execute = vi.spyOn(tx.db, "execute");
        const select = vi.spyOn(tx.db, "select");
        await EquityAt.forSeason(tx, s.seasonId, AFTER_OPEN_ISO, { wallets: ids });
        return execute.mock.calls.length + select.mock.calls.length;
      });
    expect(await count(many)).toBe(await count([many[0]!]));
    // sem lista (todas as carteiras da temporada) também
    const all = await withTransaction(database.db, async (tx) => {
      const execute = vi.spyOn(tx.db, "execute");
      const select = vi.spyOn(tx.db, "select");
      await EquityAt.forSeason(tx, s.seasonId, AFTER_OPEN_ISO);
      return execute.mock.calls.length + select.mock.calls.length;
    });
    expect(all).toBe(await count([many[0]!]));
  });

  it("igual à referência lenta que soma o extrato desde o começo, em movimentos sorteados", async () => {
    const random = rng(42);
    const wallet = await newPlayer(database.db, s.seasonId);
    const tickers = ["FLA3", "PAL3", "SPT3"];
    let minute = 0;
    const times: Date[] = [];
    for (let i = 0; i < 40; i++) {
      minute += 1 + Math.floor(random() * 90);
      const when = new Date(at("2027-04-07T13:00:00Z").getTime() + minute * 60_000);
      times.push(when);
      const ticker = tickers[Math.floor(random() * tickers.length)]!;
      const clubId = s.clubIds.get(ticker)!;
      const price = 3000 + Math.floor(random() * 2000);
      await setPrice(database.db, s, ticker, when, price);
      const [position] = await database.db.execute(sql`select shares from futbolsa.positions where wallet_id = ${wallet} and club_id = ${clubId}`).then((r) => r.rows);
      const held = Number(position?.shares ?? 0);
      if (held > 0 && random() < 0.4) await applyMovements(database.db, wallet, when, tradeSell(clubId, 1 + Math.floor(random() * held), price));
      else await applyMovements(database.db, wallet, when, tradeBuy(clubId, 1 + Math.floor(random() * 20), price));
    }
    const entries = await database.db.select().from(walletEntries).where(eq(walletEntries.walletId, wallet));
    for (const probe of [times[0]!, times[10]!, times[25]!, new Date(times[39]!.getTime() + 1000)]) {
      const mine = await equityOf(wallet, probe);
      const upTo = entries.filter((e) => e.at.getTime() <= probe.getTime());
      const cash = upTo.reduce((sum, e) => sum + e.cashDelta, 0);
      const shares = new Map<number, number>();
      for (const e of upTo) if (e.clubId) shares.set(e.clubId, (shares.get(e.clubId) ?? 0) + e.sharesDelta);
      expect(mine!.cash).toBe(cash);
      for (const p of mine!.positions) expect(p.shares).toBe(shares.get(p.clubId));
      expect(mine!.positions.length).toBe([...shares.values()].filter((n) => n > 0).length);
    }
  });
});

const AFTER_OPEN_ISO = at("2027-04-06T18:00:00Z");
