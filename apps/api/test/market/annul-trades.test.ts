import "reflect-metadata";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Cents } from "@futbolsa/engine";
import { FixedClock } from "../../src/infra/clock/index.js";
import type { Database } from "../../src/infra/db/client.js";
import { lockClubs, withTransaction } from "../../src/infra/db/index.js";
import { candles, clubs, marketRefreshRequests, tradeAnnulments, trades } from "../../src/infra/db/schema/index.js";
import { DomainError } from "../../src/infra/http/index.js";
import {
  CancelService,
  displayedPrice,
  displayedPrices,
  readRecentTrades,
  RefreshService,
  setClubPrice,
  TradeAnnulService,
  type AnnulTradesResult,
} from "../../src/modules/market/index.js";
import { PortfolioLedger, recordTrade } from "../../src/modules/portfolio/index.js";
import { useTestDatabase } from "../support/db.js";
import { assertCandlesMatchTrades } from "../support/invariants.js";
import { insertTrade, marketSeason, tradeWallets } from "./helpers.js";
import { clubRow, orderService, rolledBack, setTunnelState } from "./order-helpers.js";

// T24 do Plano do admin de jogadores e bots: `annulTrades` tira os negócios anulados por trapaça do preço exibido
// (agora e no passado), dos candles, da referência do túnel e dos últimos negócios do livro, e pede a reposição da
// casa (Admin, critério 42; propostas 16 e 24; "Decidir", passo 7). O dinheiro e as ações voltam pelo `portfolio`
// (T19), fora daqui: os negócios destes testes são de histórico, gravados sem o motor de ordens.

/** Um instante pelo relógio de Brasília. */
const brt = (day: string, time: string) => new Date(`${day}T${time}:00-03:00`);
/** A anulação do critério 42, em agosto. */
const AUG = brt("2027-08-05", "10:00");
const TICKERS = ["FLA3", "PAL3", "SPT3"];
const noFairValue = { compute: async (): Promise<Map<string, Cents>> => new Map() };

describe("annulTrades: o negócio anulado sai do preço", () => {
  const t = useTestDatabase(5);
  let db: Database;
  let seasonId: number;
  let clubIds: Map<string, number>;
  let buyer: number;
  let seller: number;
  let annulments: TradeAnnulService;

  beforeAll(async () => {
    ({ seasonId, clubIds } = await marketSeason(t.db, { tickers: TICKERS }));
  });

  /** Cada teste numa transação desfeita no fim, com os serviços montados como o Nest sobre ela. */
  const scene = (body: () => Promise<void>) => () =>
    rolledBack(t.db, async (inner) => {
      db = inner;
      ({ buyer, seller } = await tradeWallets(db, seasonId));
      const { service } = orderService(db);
      const refresher = new RefreshService(db, service, new CancelService(db, new PortfolioLedger()), noFairValue, new FixedClock(AUG));
      annulments = new TradeAnnulService(refresher);
      await body();
    });

  const club = (ticker: string) => clubIds.get(ticker)!;
  const row = (ticker: string) => clubRow(db, seasonId, club(ticker));

  /** Um negócio como o motor de ordens o deixa: a linha em `trades`, os candles e o preço exibido do clube. */
  const trade = async (
    ticker: string,
    at: Date,
    price: number,
    opts: { quantity?: number; priceBefore?: number; inAuction?: boolean; withHouse?: boolean } = {},
  ): Promise<number> => {
    const clubId = club(ticker);
    const quantity = opts.quantity ?? 1;
    const id = await insertTrade(db, { seasonId, clubId, at, price, quantity, buyerWalletId: buyer, sellerWalletId: seller, ...opts });
    await withTransaction(db, async (tx) => {
      await lockClubs(tx, seasonId, [ticker]);
      await recordTrade(tx, { clubId, at, price, quantity });
      await setClubPrice(tx, seasonId, clubId, price, at);
    });
    return id;
  };

  /** A anulação como a decisão do caso a faz: os clubes dos negócios travados antes, na mesma transação. */
  const annul = (ids: number[], at = AUG, caseId = 1): Promise<AnnulTradesResult> =>
    withTransaction(db, async (tx) => {
      const tickers = await tx.db
        .selectDistinct({ ticker: clubs.ticker })
        .from(trades)
        .innerJoin(clubs, eq(clubs.id, trades.clubId))
        .where(inArray(trades.id, ids));
      await lockClubs(tx, seasonId, tickers.map((r) => r.ticker!));
      return annulments.annulTrades(tx, {
        seasonId,
        caseId,
        at,
        trades: ids.map((tradeId) => ({ tradeId, sharesReturned: 1, cashReturned: 0, sharesShort: 0 })),
      });
    });

  /** Os candles de um clube sem o id dele, para comparar dois clubes. */
  const candlesOf = async (ticker: string) =>
    (await db.select().from(candles).where(eq(candles.clubId, club(ticker))).orderBy(asc(candles.interval), asc(candles.start))).map(
      ({ clubId: _, ...c }) => c,
    );

  const annulledCount = async () => Number((await db.execute(sql`select count(*)::int as n from futbolsa.trade_annulments`)).rows[0]!.n);

  it("admin 42: o preço exibido volta a R$ 7,00", scene(async () => {
    // o SPT3 a R$ 7,00 (o último negócio antes do par) e os 3 negócios de Ana com Bruno, uns 10% acima cada
    const before = brt("2027-07-20", "15:00");
    await trade("SPT3", before, 700, { priceBefore: 4000 });
    const ids = [
      await trade("SPT3", brt("2027-07-25", "11:00"), 770, { priceBefore: 700 }),
      await trade("SPT3", brt("2027-07-28", "11:00"), 847, { priceBefore: 770 }),
      await trade("SPT3", brt("2027-07-31", "11:00"), 931, { priceBefore: 847 }),
    ];
    expect(await displayedPrice(db, seasonId, "SPT3")).toBe(931);

    const result = await annul(ids);

    expect(await displayedPrice(db, seasonId, "SPT3")).toBe(700);
    expect(await row("SPT3")).toMatchObject({ lastPrice: 700, lastTradeAt: before });
    // o fechamento de julho sem os negócios (o ranking de julho é recalculado com R$ 7,00)
    expect(await displayedPrice(db, seasonId, "SPT3", brt("2027-07-31", "23:59"))).toBe(700);
    expect((await displayedPrices(db, seasonId, brt("2027-07-31", "23:59"))).get("SPT3")).toBe(700);
    expect(result).toEqual({
      clubs: [{ clubId: club("SPT3"), ticker: "SPT3", price: 700, lastTradeAt: before, tunnelRef: 700, since: brt("2027-07-25", "11:00") }],
      since: brt("2027-07-25", "11:00"),
    });
    const marks = await db.select().from(tradeAnnulments).where(inArray(tradeAnnulments.tradeId, ids)).orderBy(asc(tradeAnnulments.tradeId));
    expect(marks).toEqual(ids.map((tradeId) => ({ tradeId, caseId: 1, at: AUG, sharesReturned: 1, cashReturned: 0, sharesShort: 0 })));
    // `trades` não se edita: os negócios continuam lá
    expect(await db.select({ id: trades.id }).from(trades).where(inArray(trades.id, ids))).toHaveLength(3);
    await assertCandlesMatchTrades(db, seasonId);
  }));

  it("displayedPrice em T do passado ignora o anulado", scene(async () => {
    await trade("FLA3", brt("2027-07-26", "10:00"), 4100);
    const middle = await trade("FLA3", brt("2027-07-26", "11:00"), 4200);
    await trade("FLA3", brt("2027-07-26", "12:00"), 4300);
    expect(await displayedPrice(db, seasonId, "FLA3", brt("2027-07-26", "11:30"))).toBe(4200);

    await annul([middle]);

    expect(await displayedPrice(db, seasonId, "FLA3", brt("2027-07-26", "11:00"))).toBe(4100);
    expect(await displayedPrice(db, seasonId, "FLA3", brt("2027-07-26", "11:30"))).toBe(4100);
    expect(await displayedPrice(db, seasonId, "FLA3", brt("2027-07-26", "12:30"))).toBe(4300);
    expect((await displayedPrices(db, seasonId, brt("2027-07-26", "11:30"))).get("FLA3")).toBe(4100);
  }));

  it("sem nenhum negócio sobrando, vale o preço do IPO", scene(async () => {
    await setTunnelState(db, seasonId, club("PAL3"), { ipoPrice: 3500, lastPrice: 3500 });
    const only = await trade("PAL3", brt("2027-07-26", "10:00"), 4200);

    const result = await annul([only]);

    expect(await row("PAL3")).toMatchObject({ lastPrice: 3500, lastTradeAt: null, tunnelRef: 3500 });
    expect(await displayedPrice(db, seasonId, "PAL3")).toBe(3500);
    expect(await displayedPrice(db, seasonId, "PAL3", brt("2027-07-26", "10:00"))).toBe(3500);
    expect((await displayedPrices(db, seasonId, AUG)).get("PAL3")).toBe(3500);
    expect(result.clubs[0]).toMatchObject({ price: 3500, lastTradeAt: null });
    // sem negócio, sem candle
    expect(await candlesOf("PAL3")).toEqual([]);
  }));

  it("anular um negócio que não era o último não muda o preço de agora", scene(async () => {
    await trade("FLA3", brt("2027-07-26", "10:00"), 4100);
    const middle = await trade("FLA3", brt("2027-07-26", "11:00"), 4200);
    const last = brt("2027-07-26", "12:00");
    await trade("FLA3", last, 4300);

    await annul([middle]);

    expect(await displayedPrice(db, seasonId, "FLA3")).toBe(4300);
    expect(await row("FLA3")).toMatchObject({ lastPrice: 4300, lastTradeAt: last });
  }));

  it("candles iguais aos de quem nunca teve o negócio", scene(async () => {
    // FLA3 com os negócios anulados; PAL3 com os mesmos negócios, menos eles
    const scenario = async (ticker: string, withFraud: boolean): Promise<number[]> => {
      const fraud: number[] = [];
      await trade(ticker, brt("2027-07-25", "14:00"), 4000, { quantity: 7 }); // antes do primeiro anulado: não muda
      await trade(ticker, brt("2027-07-26", "09:50"), 4050, { quantity: 2 });
      if (withFraud) fraud.push(await trade(ticker, brt("2027-07-26", "10:00"), 4600, { quantity: 1 })); // abre o 15m e é a máxima do dia
      await trade(ticker, brt("2027-07-26", "10:05"), 4100, { quantity: 5 });
      await trade(ticker, brt("2027-07-26", "10:10"), 4200, { quantity: 2 });
      if (withFraud) fraud.push(await trade(ticker, brt("2027-07-26", "10:20"), 3800, { quantity: 1 })); // 15m só dele, mínima do dia
      await trade(ticker, brt("2027-07-26", "16:00"), 4150, { quantity: 1 });
      await trade(ticker, brt("2027-07-27", "09:00"), 4300, { quantity: 4 });
      return fraud;
    };
    const fraud = await scenario("FLA3", true);
    await scenario("PAL3", false);
    expect(await candlesOf("FLA3")).not.toEqual(await candlesOf("PAL3"));

    await annul(fraud);

    expect(await candlesOf("FLA3")).toEqual(await candlesOf("PAL3"));
    await assertCandlesMatchTrades(db, seasonId);
  }));

  it("referência do túnel refeita: sem o leilão anulado, volta ao preço exibido às 0h", scene(async () => {
    const today = brt("2027-08-05", "00:00");
    await trade("FLA3", brt("2027-08-04", "23:00"), 4200);
    const auction = await trade("FLA3", brt("2027-08-05", "09:30"), 4450, { inAuction: true });
    await trade("FLA3", brt("2027-08-05", "09:45"), 4500);
    // o fim do leilão gravou a referência no preço único dele
    await setTunnelState(db, seasonId, club("FLA3"), { tunnelRef: 4450, tunnelRefDay: today });

    const result = await annul([auction]);

    expect(await row("FLA3")).toMatchObject({ tunnelRef: 4200, tunnelRefDay: today, lastPrice: 4500 });
    expect(result.clubs[0]!.tunnelRef).toBe(4200);
  }));

  it("referência do túnel refeita: o negócio anulado antes das 0h sai do preço exibido às 0h", scene(async () => {
    const today = brt("2027-08-05", "00:00");
    await trade("FLA3", brt("2027-08-04", "20:00"), 4000);
    const late = await trade("FLA3", brt("2027-08-04", "23:00"), 4400);
    await setTunnelState(db, seasonId, club("FLA3"), { tunnelRef: 4400, tunnelRefDay: today });

    await annul([late]);

    expect(await row("FLA3")).toMatchObject({ tunnelRef: 4000, tunnelRefDay: today, lastPrice: 4000 });
  }));

  it("os últimos 20 negócios do livro não trazem o anulado", scene(async () => {
    const ids: number[] = [];
    for (let i = 0; i < 22; i++) ids.push(await trade("FLA3", new Date(brt("2027-07-26", "10:00").getTime() + i * 60_000), 4000 + i));
    const annulled = [ids[21]!, ids[15]!];

    await annul(annulled);

    const recent = await readRecentTrades(db, club("FLA3"));
    expect(recent).toHaveLength(20);
    expect(recent.map((r) => r.id)).toEqual(ids.filter((id) => !annulled.includes(id)).reverse().slice(0, 20));
  }));

  it("a reposição da casa fica pedida, com o motivo correction", scene(async () => {
    const id = await trade("SPT3", brt("2027-07-26", "10:00"), 770);

    await annul([id]);

    const requests = await db.select().from(marketRefreshRequests).where(eq(marketRefreshRequests.seasonId, seasonId));
    expect(requests).toEqual([expect.objectContaining({ clubId: club("SPT3"), reason: "correction", requestedAt: AUG, doneAt: null })]);
  }));

  it("negócio já anulado é recusado, e nada da segunda anulação fica gravado", scene(async () => {
    const first = await trade("FLA3", brt("2027-07-26", "10:00"), 4100);
    const second = await trade("FLA3", brt("2027-07-26", "11:00"), 4200);
    await annul([first]);

    const refused = (ids: number[]) => expect(annul(ids, AUG, 2)).rejects.toSatisfy((e) => e instanceof DomainError && e.code === "trade_not_annullable");
    await refused([first]);
    await refused([second, first]);
    await refused([second, second]); // repetido no pedido
    await refused([second, 999_999_999]); // não existe
    expect(await annulledCount()).toBe(1);
    expect(await row("FLA3")).toMatchObject({ lastPrice: 4200 });
    expect(await db.select().from(marketRefreshRequests).where(eq(marketRefreshRequests.seasonId, seasonId))).toHaveLength(1);
  }));

  it("clube não travado por quem chama é erro de programação", scene(async () => {
    const id = await trade("FLA3", brt("2027-07-26", "10:00"), 4100);
    await expect(
      withTransaction(db, (tx) =>
        annulments.annulTrades(tx, { seasonId, caseId: 1, at: AUG, trades: [{ tradeId: id, sharesReturned: 1, cashReturned: 0, sharesShort: 0 }] }),
      ),
    ).rejects.toThrow(/não está travado/);
    expect(await annulledCount()).toBe(0);
  }));

  it("ignoreTrades funciona sem anular nada", scene(async () => {
    const a = await trade("FLA3", brt("2027-07-26", "10:00"), 4100);
    const b = await trade("FLA3", brt("2027-07-26", "11:00"), 4200);
    const c = await trade("FLA3", brt("2027-07-26", "12:00"), 4300);
    await trade("PAL3", brt("2027-07-26", "12:00"), 3900);

    // agora: sem o último, vale o anterior
    expect(await displayedPrice(db, seasonId, "FLA3", undefined, { ignoreTrades: new Set([c]) })).toBe(4200);
    // no passado: sem o do meio
    expect(await displayedPrice(db, seasonId, "FLA3", brt("2027-07-26", "11:30"), { ignoreTrades: new Set([b]) })).toBe(4100);
    // sem nenhum negócio do clube, o preço do IPO; os outros clubes não mudam
    const without = await displayedPrices(db, seasonId, AUG, { ignoreTrades: new Set([a, b, c]) });
    expect(without.get("FLA3")).toBe(4000);
    expect(without.get("PAL3")).toBe(3900);
    // conjunto vazio é o mesmo que sem a opção
    expect(await displayedPrice(db, seasonId, "FLA3", undefined, { ignoreTrades: new Set() })).toBe(4300);
    expect((await displayedPrices(db, seasonId, AUG, { ignoreTrades: new Set() })).get("FLA3")).toBe(4300);

    // nada foi anulado nem gravado
    expect(await annulledCount()).toBe(0);
    expect(await displayedPrice(db, seasonId, "FLA3")).toBe(4300);
    expect(await displayedPrice(db, seasonId, "FLA3", AUG)).toBe(4300);
    expect(await row("FLA3")).toMatchObject({ lastPrice: 4300 });
  }));

  it("anular negócios de dois clubes refaz cada um e pede a reposição dos dois", scene(async () => {
    await trade("FLA3", brt("2027-07-26", "10:00"), 4100);
    const fla = await trade("FLA3", brt("2027-07-27", "10:00"), 4500);
    const pal = await trade("PAL3", brt("2027-07-26", "09:00"), 3900);

    const result = await annul([fla, pal]);

    expect(result.clubs.map((c) => [c.ticker, c.price])).toEqual([["FLA3", 4100], ["PAL3", 4000]]);
    expect(result.since).toEqual(brt("2027-07-26", "09:00"));
    const requests = await db
      .select({ clubId: marketRefreshRequests.clubId })
      .from(marketRefreshRequests)
      .where(and(eq(marketRefreshRequests.seasonId, seasonId), eq(marketRefreshRequests.reason, "correction")));
    expect(requests.map((r) => r.clubId).sort()).toEqual([club("FLA3"), club("PAL3")].sort());
    await assertCandlesMatchTrades(db, seasonId);
  }));
});
