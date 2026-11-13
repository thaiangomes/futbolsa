import { beforeAll, describe, expect, it } from "vitest";
import { withTransaction } from "../../src/infra/db/index.js";
import { tradeAnnulments } from "../../src/infra/db/schema/index.js";
import { EquityAt } from "../../src/modules/portfolio/valuation/equity-at.js";
import { useTestDatabase } from "../support/db.js";
import { insertTrade } from "../market/helpers.js";
import { applyMovements, ipoBuy, newPlayer, portfolioSeason, type PortfolioSeason } from "./support.js";

// F10, T21 (acréscimo da F14): o `EquityAt` conta a linha `trade_annulled` pelo horário do negócio original e aceita
// `ignoreTrades` (Admin 42; P11 do Plano dos rankings).

const at = (iso: string) => new Date(iso);
const D5 = at("2027-04-05T14:00:00Z");
const TRADE_AT = at("2027-04-06T13:00:00Z");
const ANNUL_AT = at("2027-04-20T13:00:00Z");

describe("valuation: negócio anulado", () => {
  const database = useTestDatabase(8);
  let s: PortfolioSeason;
  let fla: number;
  let ana: number;
  let bruno: number;
  let tradeId: number;

  const equityOf = (walletId: number, when: Date, ignoreTrades?: ReadonlySet<number>) =>
    withTransaction(database.db, async (tx) => (await EquityAt.forSeason(tx, s.seasonId, when, { wallets: [walletId], ...(ignoreTrades ? { ignoreTrades } : {}) })).get(walletId)!);

  beforeAll(async () => {
    s = await portfolioSeason(database.db);
    fla = s.clubIds.get("FLA3")!;
    ana = await newPlayer(database.db, s.seasonId);
    bruno = await newPlayer(database.db, s.seasonId);
    await applyMovements(database.db, ana, D5, ipoBuy(fla, 10, 4000));
    await applyMovements(database.db, bruno, D5, ipoBuy(fla, 10, 4000));
    // Ana compra 1 ação de Bruno a R$ 44,00 (R$ 4,00 acima do preço do IPO)
    tradeId = await insertTrade(database.db, { seasonId: s.seasonId, clubId: fla, at: TRADE_AT, price: 4400, priceBefore: 4000, quantity: 1, buyerWalletId: ana, sellerWalletId: bruno });
    const ref = { type: "trade", id: tradeId };
    await applyMovements(database.db, ana, TRADE_AT, { kind: "trade", clubId: fla, sharesDelta: 1, cashDelta: -4400, price: 4400, costBasis: "purchase", ref });
    await applyMovements(database.db, bruno, TRADE_AT, { kind: "trade", clubId: fla, sharesDelta: -1, cashDelta: 4400, price: 4400, costBasis: "sale", ref });
  });

  it("admin 42: ignoreTrades tira o negócio da conta e do preço, sem anular nada", async () => {
    const now = at("2027-04-10T12:00:00Z");
    const with_ = await equityOf(ana, now);
    expect(with_).toMatchObject({ cash: 10_000_000 - 40_000 - 4400 });
    expect(with_.positions[0]).toMatchObject({ shares: 11, price: 4400 });

    const without = await equityOf(ana, now, new Set([tradeId]));
    expect(without.cash).toBe(10_000_000 - 40_000);
    expect(without.positions[0]).toMatchObject({ shares: 10, price: 4000 });
    expect(without.equity).toBe(10_000_000 - 40_000 + 10 * 4000);

    const bruno_ = await equityOf(bruno, now, new Set([tradeId]));
    expect(bruno_.positions[0]).toMatchObject({ shares: 10, price: 4000 });
    expect(bruno_.cash).toBe(10_000_000 - 40_000);
  });

  it("admin 42: a linha trade_annulled conta pelo horário do negócio, não pelo da anulação", async () => {
    const ref = { type: "trade", id: tradeId };
    await applyMovements(
      database.db,
      ana,
      ANNUL_AT,
      { kind: "trade_annulled", clubId: fla, sharesDelta: -1, cashDelta: 4400, price: 4400, ref, reason: "trapaça", annulled: { cost: 400_000, realized: 0 } },
    );
    await applyMovements(
      database.db,
      bruno,
      ANNUL_AT,
      { kind: "trade_annulled", clubId: fla, sharesDelta: 1, cashDelta: -4400, price: 4400, ref, reason: "trapaça", annulled: { cost: 400_000, realized: 0 } },
    );
    await database.db.insert(tradeAnnulments).values({ tradeId, caseId: 1, at: ANNUL_AT, sharesReturned: 1, cashReturned: 4400 });
    // em T depois do negócio e antes da anulação, o negócio e o desfazer cancelam: é como se ele não tivesse existido
    const between = await equityOf(ana, at("2027-04-10T12:00:00Z"));
    expect(between.cash).toBe(10_000_000 - 40_000);
    expect(between.positions[0]).toMatchObject({ shares: 10 });
    // antes do negócio, nada mudou
    const before = await equityOf(ana, at("2027-04-06T12:00:00Z"));
    expect(before.cash).toBe(10_000_000 - 40_000);
    expect(before.positions[0]).toMatchObject({ shares: 10 });
    // hoje: igual
    const today = await equityOf(ana, at("2027-04-25T12:00:00Z"));
    expect(today.cash).toBe(10_000_000 - 40_000);
    expect(today.positions[0]).toMatchObject({ shares: 10, price: 4000 });
    const brunoToday = await equityOf(bruno, at("2027-04-25T12:00:00Z"));
    expect(brunoToday.positions[0]).toMatchObject({ shares: 10, price: 4000 });
    expect(brunoToday.cash).toBe(10_000_000 - 40_000);
  });
});
