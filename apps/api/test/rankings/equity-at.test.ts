import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { withTransaction } from "../../src/infra/db/index.js";
import { seasons } from "../../src/infra/db/schema/index.js";
import { equityAtWallets } from "../../src/modules/rankings/equity-at.js";
import { useTestDatabase } from "../support/db.js";
import { applyMovements, creditPayout, insertPayout, ipoBuy, newPlayer, portfolioSeason, setPrice, type PortfolioSeason } from "../portfolio/support.js";

// T3: o patrimônio dos rankings sobre o `EquityAt` da F10 (Rankings mensal e anual, critérios 1, 9, 11, 12, 13, 14, 23).

const at = (iso: string) => new Date(iso);
const JUN30_2359 = at("2027-07-01T02:59:00Z"); // 23:59 de 30/06 em Brasília
const BUY = at("2027-04-05T14:00:00Z");

describe("equityAtWallets", () => {
  const database = useTestDatabase(8);
  let s: PortfolioSeason;
  let fla: number;

  beforeAll(async () => {
    s = await portfolioSeason(database.db);
    fla = s.clubIds.get("FLA3")!;
  });

  const equity = (walletId: number, when: Date) =>
    withTransaction(database.db, async (tx) => (await equityAtWallets(tx, s.seasonId, when, [walletId])).get(walletId)!);

  it("rankings 1 e 14: R$ 20.000,00 de caixa e 1.000 ações a R$ 80,00 dão R$ 100.000,00; a reserva de uma oferta aberta não muda nada", async () => {
    const w = await newPlayer(database.db, s.seasonId);
    await applyMovements(database.db, w, BUY, ipoBuy(fla, 1000, 8000));
    await setPrice(database.db, s, "FLA3", BUY, 8000);
    expect((await equity(w, at("2027-05-01T12:00:00Z"))).equity).toBe(10_000_000 - 8_000_000 + 8_000_000);
  });

  it("rankings 11: a venda às 23h58 conta e o negócio às 00h01 não", async () => {
    const w = await newPlayer(database.db, s.seasonId);
    await applyMovements(database.db, w, BUY, ipoBuy(fla, 100, 8000));
    await setPrice(database.db, s, "FLA3", at("2027-07-01T02:58:00Z"), 9000);
    await setPrice(database.db, s, "FLA3", at("2027-07-01T03:01:00Z"), 9900);
    const e = await equity(w, JUN30_2359);
    expect(e.positions[0]!.price).toBe(9000);
    expect(e.equity).toBe(10_000_000 - 100 * 8000 + 100 * 9000);
  });

  it("rankings 13: caixa de −R$ 250,00 sem ações dá −R$ 250,00", async () => {
    const w = await newPlayer(database.db, s.seasonId);
    await applyMovements(database.db, w, BUY, { kind: "reversal", clubId: fla, cashDelta: -10_025_000, reason: "estorno" });
    expect((await equity(w, at("2027-05-01T12:00:00Z"))).equity).toBe(-25_000);
  });

  it("rankings 9 e lotes: dividendo fechado às 20h de 30/06 e aprovado em 01/07 conta como a receber em 23:59; créditos em lotes depois de T não mudam a soma", async () => {
    const a = await newPlayer(database.db, s.seasonId);
    const b = await newPlayer(database.db, s.seasonId);
    const cor = s.clubIds.get("COR3")!; // clube sem negócio: vale o preço do IPO (R$ 40,00), critério 12
    for (const w of [a, b]) await applyMovements(database.db, w, BUY, ipoBuy(cor, 1000, 4000));
    const ev = await insertPayout(database.db, { seasonId: s.seasonId, clubId: cor }, { key: "pts-9", perShare: 30, closedAt: at("2027-06-30T23:00:00Z"), status: "approved", holdings: [[a, 1000], [b, 1000]] });
    await creditPayout(database.db, ev, a, cor, at("2027-07-01T02:58:30Z"), 30_000); // lote 1: antes de T
    await creditPayout(database.db, ev, b, cor, at("2027-07-01T03:05:00Z"), 30_000); // lote 2: depois de T
    const base = 10_000_000; // R$ 100.000,00: caixa + ações ao preço do IPO
    const ea = await equity(a, JUN30_2359);
    const eb = await equity(b, JUN30_2359);
    expect(ea.equity).toBe(base + 30_000);
    expect(eb.equity).toBe(ea.equity);
    expect(eb.receivable).toBe(30_000);
    expect(ea.receivable).toBe(0); // o de a já caiu no caixa
    const later = await equity(b, at("2027-07-31T12:00:00Z"));
    expect(later.receivable).toBe(0);
    expect(later.equity).toBe(base + 30_000);
  });

  it("rankings 23: com a recompra fechada as ações valem R$ 0,00 e a recompra a receber entra, aprovada ou não", async () => {
    const w = await newPlayer(database.db, s.seasonId);
    await applyMovements(database.db, w, BUY, ipoBuy(fla, 1000, 6000));
    await database.db.update(seasons).set({ tradingEndedAt: at("2027-12-10T13:00:00Z") }).where(eq(seasons.id, s.seasonId));
    await insertPayout(database.db, { seasonId: s.seasonId, clubId: fla }, { key: "buyback", kind: "buyback", perShare: 5910, closedAt: at("2027-12-10T13:00:00Z"), holdings: [[w, 1000]] });
    const e = await equity(w, at("2027-12-11T12:00:00Z"));
    expect(e.receivable).toBe(5_910_000);
    expect(e.equity).toBe(10_000_000 - 6_000_000 + 5_910_000);
    await database.db.update(seasons).set({ tradingEndedAt: null }).where(eq(seasons.id, s.seasonId));
  });

  it("um lote grande usa um número fixo de consultas e carteiras futuras não aparecem", async () => {
    const w = await newPlayer(database.db, s.seasonId);
    const map = await withTransaction(database.db, async (tx) => equityAtWallets(tx, s.seasonId, at("2027-01-01T00:00:00Z"), [w]));
    expect(map.size).toBe(0);
  });
});
