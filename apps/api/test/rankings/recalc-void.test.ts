import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { FixedClock } from "../../src/infra/clock/index.js";
import { seasons, tradeAnnulments } from "../../src/infra/db/schema/index.js";
import { closeAtOfMonth } from "../../src/modules/rankings/base.js";
import { CloseService } from "../../src/modules/rankings/close.service.js";
import { RecalcService } from "../../src/modules/rankings/recalc.service.js";
import { currentRowsOf, currentSnapshot } from "../../src/modules/rankings/snapshots.js";
import { insertTrade } from "../market/helpers.js";
import { useTestDatabase } from "../support/db.js";
import { BASE, applyMovements, br, inTx, ipoBuy, player, portfolioSeason, type PortfolioSeason } from "./support.js";

// F13, T12 (acréscimo da F14): negócios anulados por trapaça no recálculo (Rankings 28 e Admin 39 a 45). O ranking oficial de
// julho é refeito sem os negócios, com a versão antiga guardada.

describe("recálculo: negócios anulados por trapaça", () => {
  const database = useTestDatabase(8);
  let s: PortfolioSeason;
  let fla: number;
  let recalc: RecalcService;
  let close: CloseService;

  const rows = (key: string) => inTx(database.db, async (tx) => (await currentRowsOf(tx, s.seasonId, "month", key))!);
  const version = (key: string) => inTx(database.db, async (tx) => (await currentSnapshot(tx, s.seasonId, "month", key))!.version);

  beforeAll(async () => {
    s = await portfolioSeason(database.db);
    fla = s.clubIds.get("FLA3")!;
    const clock = new FixedClock(br("2027-10-01 12:00"));
    close = new CloseService(database.db, clock);
    recalc = new RecalcService(database.db, clock);
    await database.db.update(seasons).set({ ipoOpensAt: br("2027-04-01 10:00") }).where(eq(seasons.id, s.seasonId));
  });

  it("rankings 28: Carla em 1º com o FLA3 a R$ 53,24; a anulação gera a versão 2 de julho com o FLA3 a R$ 40,00, e a versão 1 continua", async () => {
    const ana = await player(database.db, s.seasonId);
    const bruno = await player(database.db, s.seasonId);
    const carla = await player(database.db, s.seasonId);
    const other = await player(database.db, s.seasonId);
    await applyMovements(database.db, bruno.wallet, br("2027-04-05 11:00"), ipoBuy(fla, 10, 4000));
    await applyMovements(database.db, carla.wallet, br("2027-04-05 11:00"), ipoBuy(fla, 1000, 4000));

    // Ana compra 1 FLA3 de Bruno três vezes, 10% acima do preço anterior em cada uma
    const prices = [4400, 4840, 5324];
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const when = br(`2027-07-1${i} 12:00`);
      const id = await insertTrade(database.db, { seasonId: s.seasonId, clubId: fla, at: when, price: prices[i]!, priceBefore: i === 0 ? 4000 : prices[i - 1]!, quantity: 1, buyerWalletId: ana.wallet, sellerWalletId: bruno.wallet });
      ids.push(id);
      const ref = { type: "trade", id };
      await applyMovements(database.db, ana.wallet, when, { kind: "trade", clubId: fla, sharesDelta: 1, cashDelta: -prices[i]!, price: prices[i]!, costBasis: "purchase", ref });
      await applyMovements(database.db, bruno.wallet, when, { kind: "trade", clubId: fla, sharesDelta: -1, cashDelta: prices[i]!, price: prices[i]!, costBasis: "sale", ref });
    }
    await inTx(database.db, (tx) => close.closeMonth(tx, { seasonId: s.seasonId, monthKey: "2027-07", at: closeAtOfMonth("2027-07") }));
    const v1 = await rows("2027-07");
    expect(v1.get(carla.wallet)).toMatchObject({ position: 1, equity: BASE + 1000 * (5324 - 4000) });
    expect(v1.get(other.wallet)!.equity).toBe(BASE);

    // a anulação, em agosto: as linhas que desfazem entram no extrato com o horário da anulação e a marca dos negócios
    const annulAt = br("2027-08-05 10:00");
    for (let i = 2; i >= 0; i--) {
      const ref = { type: "trade", id: ids[i]! };
      const left = i; // negócios que sobram no fim desta linha
      await applyMovements(database.db, ana.wallet, annulAt, { kind: "trade_annulled", clubId: fla, sharesDelta: -1, cashDelta: prices[i]!, price: prices[i]!, ref, reason: "trapaça", annulled: { cost: left === 0 ? 0 : prices.slice(0, left).reduce((a, b) => a + b, 0), realized: 0 } });
      await applyMovements(database.db, bruno.wallet, annulAt, { kind: "trade_annulled", clubId: fla, sharesDelta: 1, cashDelta: -prices[i]!, price: prices[i]!, ref, reason: "trapaça", annulled: { cost: (7 + (3 - left)) * 4000, realized: 0 } });
      await database.db.insert(tradeAnnulments).values({ tradeId: ids[i]!, caseId: 1, at: annulAt, sharesReturned: 1, cashReturned: prices[i]! });
    }
    await inTx(database.db, (tx) => recalc.requestRecalc(tx, { seasonId: s.seasonId, from: br("2027-07-10 12:00"), reason: "trapaça: negócios anulados" }));
    const done = await recalc.processRecalcRequests(br("2027-08-05 11:00"));
    expect(done[0]!.versions).toContain("month:2027-07");

    expect(await version("2027-07")).toBe(2);
    const v2 = await rows("2027-07");
    // o preço de fechamento volta ao último negócio não anulado (o preço do IPO) para todos que tinham FLA3
    expect(v2.get(carla.wallet)!.equity).toBe(BASE);
    // Ana e Bruno saem como se os negócios não tivessem existido (P11: as linhas contam pelo horário do negócio)
    expect(v2.get(ana.wallet)!.equity).toBe(BASE);
    expect(v2.get(bruno.wallet)!.equity).toBe(BASE);
    // sem Carla à frente por causa do preço inflado, ninguém lidera por mérito dos negócios
    expect(v2.get(carla.wallet)!.position).toBe(v2.get(other.wallet)!.position);
  });
});
