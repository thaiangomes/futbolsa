import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { orders, seasonClubs, trades } from "../../src/infra/db/schema/index.js";
import { withTransaction } from "../../src/infra/db/index.js";
import {
  insertOrderRow,
  insertTradeRow,
  myOpenOrdersInClub,
  oppositeSideQuery,
  readBookLevels,
  readOppositeSide,
  readRecentTrades,
  setClubPrice,
  updateOrderProgress,
} from "../../src/modules/market/index.js";
import { useTestDatabase } from "../support/db.js";
import { openPlayerWallets } from "../support/fixtures.js";
import { insertOpenOrder, insertTrade, marketSeason, type MarketSeason } from "./helpers.js";

// T3 do Plano do livro de ofertas e formador: o livro no banco.

describe("livro no banco", () => {
  const t = useTestDatabase();
  let s: MarketSeason;
  let w: number[];

  beforeAll(async () => {
    s = await marketSeason(t.db);
    w = await openPlayerWallets(t.db, s.seasonId, 4);
  });

  const fla = () => s.clubIds.get("FLA3")!;
  const pal = () => s.clubIds.get("PAL3")!;
  const sell = (walletId: number, price: number, quantity: number, clubId = fla(), filled = 0) =>
    insertOpenOrder(t.db, { seasonId: s.seasonId, clubId, walletId, side: "sell", price, quantity, filled });
  const buy = (walletId: number, price: number, quantity: number, clubId = fla()) =>
    insertOpenOrder(t.db, { seasonId: s.seasonId, clubId, walletId, side: "buy", price, quantity });

  it("o outro lado vem em ordem de prioridade (melhor preço; no mesmo preço, a mais antiga) só até o preço da ordem", async () => {
    // livro 2: Bruno 100 a R$ 41,00, Carla 100 a R$ 41,00 (depois) e Davi 100 a R$ 40,50
    const bruno = await sell(w[0]!, 4100, 100);
    const carla = await sell(w[1]!, 4100, 100);
    const davi = await sell(w[2]!, 4050, 100);
    await sell(w[2]!, 4200, 100); // acima do preço da ordem: não é lido
    const read = await readOppositeSide(t.db, { clubId: fla(), incomingSide: "buy", price: 4100 });
    expect(read.map((o) => o.id)).toEqual([davi, bruno, carla]);
    expect(read[0]).toMatchObject({ id: davi, walletId: w[2], side: "sell", limitPrice: 4050, remaining: 100 });
  });

  it("a venda que chega lê as compras do maior preço para o menor, e a ordem a mercado lê até o limite dela", async () => {
    const lowBid = await buy(w[0]!, 3900, 10, pal());
    const highBid = await buy(w[1]!, 4000, 10, pal());
    const midBid = await buy(w[2]!, 3950, 10, pal());
    expect((await readOppositeSide(t.db, { clubId: pal(), incomingSide: "sell", price: 3900 })).map((o) => o.id)).toEqual([highBid, midBid, lowBid]);
    expect((await readOppositeSide(t.db, { clubId: pal(), incomingSide: "sell", price: 3950 })).map((o) => o.id)).toEqual([highBid, midBid]);
  });

  it("sem preço (a mercado sem limite), lê o livro inteiro; só ordens abertas, com o que falta executar", async () => {
    const spt = s.clubIds.get("SPT3")!;
    await sell(w[0]!, 5000, 100, spt, 40);
    const cancelled = await sell(w[1]!, 4000, 10, spt);
    await t.db.update(orders).set({ status: "cancelled", cancelReason: "player" }).where(eq(orders.id, cancelled));
    const done = await sell(w[1]!, 4000, 10, spt, 10);
    await t.db.update(orders).set({ status: "filled" }).where(eq(orders.id, done));
    const read = await readOppositeSide(t.db, { clubId: spt, incomingSide: "buy" });
    expect(read).toHaveLength(1);
    expect(read[0]).toMatchObject({ limitPrice: 5000, remaining: 60 });
  });

  it("a leitura em páginas devolve o mesmo que a leitura de uma vez, sem repetir nem pular", async () => {
    const cor = s.clubIds.get("COR3")!;
    for (let i = 0; i < 11; i++) await sell(w[i % 4]!, 4000 + (i % 3) * 10, 5 + i, cor);
    const all = await readOppositeSide(t.db, { clubId: cor, incomingSide: "buy", price: 4100 }, 1000);
    expect(all).toHaveLength(11);
    const paged: typeof all = [];
    for (;;) {
      const page = await readOppositeSide(t.db, { clubId: cor, incomingSide: "buy", price: 4100, after: paged.at(-1) }, 3);
      paged.push(...page);
      if (page.length < 3) break;
    }
    expect(paged.map((o) => o.id)).toEqual(all.map((o) => o.id));
    // ordem de prioridade
    expect(all.map((o) => o.limitPrice)).toEqual([...all.map((o) => o.limitPrice)].sort((a, b) => a - b));
  });

  it("a consulta do outro lado usa o índice do livro (orders_book_idx) e para no preço da ordem", async () => {
    // com poucas linhas o planejador prefere varrer a tabela: desliga a varredura para ver o índice que ele escolheria
    const query = oppositeSideQuery(t.db, { clubId: fla(), incomingSide: "buy", price: 4100 }, 50).toSQL();
    const client = await t.conn.pool.connect();
    try {
      await client.query("set enable_seqscan = off");
      await client.query("set enable_bitmapscan = off");
      const plan = await client.query(`explain ${query.sql}`, query.params);
      const text = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
      expect(text).toContain("orders_book_idx");
      expect(text).toMatch(/Index Cond:.*limit_price <= /);
    } finally {
      client.release();
    }
  });

  it("as ordens abertas da própria carteira no clube, para a regra de ordem contra si mesmo", async () => {
    const own = await myOpenOrdersInClub(t.db, w[0]!, fla());
    expect(own).toEqual([{ id: expect.any(Number), side: "sell", limitPrice: 4100, remaining: 100 }]);
    expect(await myOpenOrdersInClub(t.db, w[3]!, fla())).toEqual([]);
  });

  it("livro 18: os 5 melhores preços de cada lado com a quantidade somada e o número de ordens", async () => {
    const book = await readBookLevels(t.db, fla());
    expect(book.asks).toEqual([
      { price: 4050, quantity: 100, orders: 1 },
      { price: 4100, quantity: 200, orders: 2 },
      { price: 4200, quantity: 100, orders: 1 },
    ]);
    expect(book.bids).toEqual([]);
    const pb = await readBookLevels(t.db, pal());
    expect(pb.bids.map((l) => l.price)).toEqual([4000, 3950, 3900]);
  });

  it("livro 19: os 20 últimos negócios, sem comprador nem vendedor", async () => {
    const seasonId = s.seasonId;
    for (let i = 0; i < 25; i++) {
      await insertTrade(t.db, { seasonId, clubId: fla(), at: new Date(Date.UTC(2027, 3, 6, 13, i)), price: 4000 + i, quantity: 1, buyerWalletId: w[0]!, sellerWalletId: w[1]! });
    }
    const shown = await readRecentTrades(t.db, fla());
    expect(shown).toHaveLength(20);
    expect(shown[0]!.price).toBe(4024);
    expect(shown[19]!.price).toBe(4005);
    expect(shown[0]).toEqual({ id: expect.any(Number), at: "2027-04-06T13:24:00.000Z", price: 4024, quantity: 1 });
  });

  it("grava ordem, negócio, andamento da ordem e last_price", async () => {
    const cor = s.clubIds.get("COR3")!;
    await withTransaction(t.db, async (tx) => {
      const a = await insertOrderRow(tx, {
        seasonId: s.seasonId,
        clubId: cor,
        walletId: w[0]!,
        side: "buy",
        type: "limit",
        quantity: 100,
        limitPrice: 4500,
        reservedCash: 450_000,
        status: "open",
        at: new Date("2027-04-07T13:00:00Z"),
        idempotencyKey: "k-1",
      });
      const b = await insertOrderRow(tx, {
        seasonId: s.seasonId,
        clubId: cor,
        walletId: w[1]!,
        side: "sell",
        type: "limit",
        quantity: 100,
        limitPrice: 4400,
        reservedCash: 0,
        status: "open",
        at: new Date("2027-04-07T12:00:00Z"),
      });
      const id = await insertTradeRow(tx, {
        seasonId: s.seasonId,
        clubId: cor,
        at: new Date("2027-04-07T13:00:00Z"),
        price: 4400,
        quantity: 60,
        buyOrderId: a,
        sellOrderId: b,
        buyerWalletId: w[0]!,
        sellerWalletId: w[1]!,
        withHouse: false,
        priceBefore: 4000,
        inAuction: false,
      });
      await updateOrderProgress(tx, a, { filled: 60, status: "open", reservedCash: 180_000, at: new Date("2027-04-07T13:00:00Z") });
      await updateOrderProgress(tx, b, { filled: 100, status: "filled", reservedCash: 0, at: new Date("2027-04-07T13:00:00Z") });
      await setClubPrice(tx, s.seasonId, cor, 4400, new Date("2027-04-07T13:00:00Z"));
      expect(id).toBeGreaterThan(0);
    });
    const [buyRow] = await t.db.select().from(orders).where(eq(orders.idempotencyKey, "k-1"));
    expect(buyRow).toMatchObject({ filled: 60, status: "open", reservedCash: 180_000 });
    const [club] = await t.db.select().from(seasonClubs).where(eq(seasonClubs.clubId, cor));
    expect(club).toMatchObject({ lastPrice: 4400, lastTradeAt: new Date("2027-04-07T13:00:00Z") });
    const [trade] = await t.db.select().from(trades).where(eq(trades.clubId, cor));
    expect(trade).toMatchObject({ price: 4400, quantity: 60, priceBefore: 4000, inAuction: false, withHouse: false });
    expect((await t.db.execute(sql`select count(*)::int as n from futbolsa.orders where club_id = ${cor} and status = 'open'`)).rows[0]!.n).toBe(1 + 11);
  });
});
