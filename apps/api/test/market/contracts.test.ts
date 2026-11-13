import { describe, expect, it } from "vitest";
import { validateOrder, type RejectCode } from "@futbolsa/engine";
import {
  EVENT_CATALOG,
  MARKET_ERROR_MESSAGES,
  ORDER_REJECT_CODES,
  bookEventSchema,
  bookViewSchema,
  candleEventSchema,
  channelAcceptsEvent,
  marketMakerBodySchema,
  matchModeEventSchema,
  orderUpdatedEventSchema,
  placeOrderBodySchema,
  placeOrderResponseSchema,
  priceEventSchema,
  tradeEventSchema,
} from "@futbolsa/contracts";

// T1 do Plano do livro de ofertas e formador: os contratos de ordens, livro, eventos e do formador no admin.

const level = { price: 4410, quantity: 10, orders: 1 };
const trade = { id: 7, at: "2027-04-05T13:05:00.000Z", price: 4430, quantity: 50 };

describe("contratos: códigos de recusa", () => {
  it("contratos: os códigos de recusa são exatamente o RejectCode do motor mais os cinco do banco (um é do bot desligado, F14)", () => {
    // Igualdade nos dois sentidos, conferida pelo compilador: se o motor ganhar ou perder um código, o typecheck falha.
    type Engine = RejectCode;
    type Database = "account_blocked" | "bot_inactive" | "email_not_confirmed" | "club_suspended" | "market_closed";
    type Contract = (typeof ORDER_REJECT_CODES)[number];
    const same: [Exclude<Engine | Database, Contract>, Exclude<Contract, Engine | Database>] extends [never, never] ? true : false = true;
    expect(same).toBe(true);
    expect([...ORDER_REJECT_CODES].sort()).toEqual(
      [
        "invalid_quantity",
        "invalid_price",
        "below_min_price",
        "negative_cash",
        "price_out_of_band",
        "too_many_open_orders",
        "insufficient_cash",
        "insufficient_shares",
        "self_trade",
        "club_in_auction",
        "account_blocked",
        "bot_inactive",
        "email_not_confirmed",
        "club_suspended",
        "market_closed",
      ].sort(),
    );
  });

  it("cada código de recusa e de cancelamento tem mensagem em português", () => {
    for (const code of ORDER_REJECT_CODES) expect(MARKET_ERROR_MESSAGES[code].length).toBeGreaterThan(10);
    for (const code of ["order_not_found", "order_not_open", "idempotency_conflict"] as const) {
      expect(MARKET_ERROR_MESSAGES[code].length).toBeGreaterThan(10);
    }
    expect(MARKET_ERROR_MESSAGES.club_in_auction).toMatch(/limitada/);
  });
});

describe("contratos: POST /orders", () => {
  it("aceita a limitada e a ordem a mercado", () => {
    expect(placeOrderBodySchema.safeParse({ ticker: "FLA3", side: "buy", type: "limit", quantity: 100, limitPrice: 4450 }).success).toBe(true);
    expect(placeOrderBodySchema.safeParse({ ticker: "FLA3", side: "sell", type: "market", quantity: 50 }).success).toBe(true);
  });

  it("não aceita campo a mais, ticker ou lado inválidos, nem a mercado com preço, nem limitada sem preço", () => {
    const base = { ticker: "FLA3", side: "buy", type: "limit", quantity: 1, limitPrice: 4000 };
    expect(placeOrderBodySchema.safeParse({ ...base, walletId: 3 }).success).toBe(false);
    expect(placeOrderBodySchema.safeParse({ ...base, ticker: "fla3" }).success).toBe(false);
    expect(placeOrderBodySchema.safeParse({ ...base, side: "short" }).success).toBe(false);
    expect(placeOrderBodySchema.safeParse({ ...base, type: "market" }).success).toBe(false);
    expect(placeOrderBodySchema.safeParse({ ...base, limitPrice: undefined }).success).toBe(false);
  });

  it("livro 14: quantidade 0 ou 1,5 e preço de R$ 40,005 chegam ao motor, que recusa com o código certo", () => {
    // O esquema só pede números (como o do IPO): quem diz "invalid_quantity" e "invalid_price" é o `validateOrder`,
    // o mesmo que a boleta usa no navegador, para o jogador ver o motivo e não um "dados inválidos".
    const state = { displayedPrice: 4000, cash: 1_000_000, availableCash: 1_000_000, availableShares: 100, openOrders: 0, myOpenOrders: [] };
    for (const [quantity, limitPrice, code] of [
      [0, 4000, "invalid_quantity"],
      [1.5, 4000, "invalid_quantity"],
      [1, 4000.5, "invalid_price"],
    ] as const) {
      const body = { ticker: "FLA3", side: "buy", type: "limit", quantity, limitPrice };
      expect(placeOrderBodySchema.safeParse(body).success).toBe(true);
      expect(validateOrder({ side: "buy", type: "limit", quantity, limitPrice }, state)).toEqual({ ok: false, code });
    }
    // O que não é número nem passa do esquema.
    expect(placeOrderBodySchema.safeParse({ ticker: "FLA3", side: "buy", type: "limit", quantity: "100", limitPrice: 4000 }).success).toBe(false);
    expect(placeOrderBodySchema.safeParse({ ticker: "FLA3", side: "buy", type: "limit", quantity: Number.NaN, limitPrice: 4000 }).success).toBe(false);
  });

  it("a resposta diz se a ordem abriu um leilão e traz o caixa", () => {
    const response = {
      order: {
        id: 12,
        ticker: "FLA3",
        side: "buy",
        type: "limit",
        quantity: 100,
        filled: 0,
        limitPrice: 4500,
        reservedCash: 450_000,
        status: "open",
        cancelReason: null,
        createdAt: "2027-04-05T15:40:00.000Z",
        updatedAt: "2027-04-05T15:40:00.000Z",
      },
      trades: [],
      openedAuction: true,
      auction: { until: "2027-04-05T18:40:00.000Z" },
      cash: { total: 1_000_000, reserved: 450_000, free: 550_000 },
    };
    expect(placeOrderResponseSchema.safeParse(response).success).toBe(true);
    expect(placeOrderResponseSchema.safeParse({ ...response, order: { ...response.order, walletId: 9 } }).success).toBe(false);
    expect(placeOrderResponseSchema.safeParse({ ...response, trades: [{ ...trade, buyerWalletId: 3 }] }).success).toBe(false);
  });
});

describe("contratos: livro e eventos do mercado", () => {
  const book = { bids: [level], asks: [{ ...level, price: 4430, orders: 2 }], auction: null };

  it("livro 18 e 19: o livro e os negócios não têm campo de dono, de contraparte nem de casa (esquema estrito)", () => {
    expect(bookEventSchema.safeParse(book).success).toBe(true);
    expect(bookEventSchema.safeParse({ ...book, bids: [{ ...level, walletId: 4 }] }).success).toBe(false);
    expect(bookEventSchema.safeParse({ ...book, bids: [{ ...level, house: true }] }).success).toBe(false);
    expect(tradeEventSchema.safeParse(trade).success).toBe(true);
    expect(tradeEventSchema.safeParse({ ...trade, buyer: "Ana" }).success).toBe(false);
    expect(tradeEventSchema.safeParse({ ...trade, withHouse: true }).success).toBe(false);
  });

  it("o livro mostra no máximo 5 níveis de cada lado", () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ price: 4400 + i, quantity: 1, orders: 1 }));
    expect(bookEventSchema.safeParse({ ...book, asks: six }).success).toBe(false);
    expect(bookEventSchema.safeParse({ ...book, asks: six.slice(0, 5) }).success).toBe(true);
  });

  it("o estado do leilão: até quando, vazio enquanto parado pela suspensão, nulo fora de leilão (P11)", () => {
    for (const auction of [null, { until: null }, { until: "2027-04-05T18:40:00.000Z" }]) {
      expect(bookEventSchema.safeParse({ ...book, auction }).success).toBe(true);
      expect(priceEventSchema.safeParse({ ticker: "FLA3", price: 4000, changeBp: 500, auction }).success).toBe(true);
    }
    expect(bookEventSchema.safeParse({ ...book, auction: { until: 12 } }).success).toBe(false);
  });

  it("price, match_mode, candle e order.updated têm esquema", () => {
    expect(priceEventSchema.safeParse({ ticker: "FLA3", price: 4200, changeBp: 500, auction: null }).success).toBe(true);
    expect(matchModeEventSchema.safeParse({ active: true }).success).toBe(true);
    expect(
      candleEventSchema.safeParse({ interval: "15m", start: "2027-04-05T13:00:00.000Z", open: 4300, high: 4430, low: 4300, close: 4430, volume: 100 }).success,
    ).toBe(true);
    expect(candleEventSchema.safeParse({ interval: "1h", start: "2027-04-05T13:00:00.000Z", open: 1, high: 1, low: 1, close: 1, volume: 1 }).success).toBe(false);
    expect(
      orderUpdatedEventSchema.safeParse({
        id: 12,
        ticker: "FLA3",
        side: "buy",
        type: "limit",
        quantity: 100,
        filled: 60,
        limitPrice: 4450,
        reservedCash: 178_000,
        status: "open",
        cancelReason: null,
      }).success,
    ).toBe(true);
  });

  it("a visão de GET /clubs/:ticker/book: visitante sem faixa nem saldo; logado com os dois", () => {
    const base = {
      ticker: "FLA3",
      seq: 42,
      price: { displayed: 4430, open: 4219, changeBp: 500 },
      matchMode: false,
      auction: null,
      market: { state: "open" as const, opensAt: "2027-04-05T13:00:00.000Z", reason: null },
      bids: [level],
      asks: [{ ...level, price: 4430 }],
      trades: [trade],
      me: null,
    };
    expect(bookViewSchema.safeParse(base).success).toBe(true);
    const logged = { ...base, me: { band: { min: 3544, max: 5316 }, freeCash: 550_000, freeShares: 12 } };
    expect(bookViewSchema.safeParse(logged).success).toBe(true);
    expect(bookViewSchema.safeParse({ ...base, trades: Array.from({ length: 21 }, (_, i) => ({ ...trade, id: i })) }).success).toBe(false);
    expect(bookViewSchema.safeParse({ ...base, email: "ana@example.com" }).success).toBe(false);
  });

  it("os eventos do mercado pertencem aos canais certos do catálogo", () => {
    expect(channelAcceptsEvent("club:FLA3", "trade")).toBe(true);
    expect(channelAcceptsEvent("club:FLA3", "book")).toBe(true);
    expect(channelAcceptsEvent("club:FLA3", "match_mode")).toBe(true);
    expect(channelAcceptsEvent("club:FLA3", "candle")).toBe(true);
    expect(channelAcceptsEvent("prices", "price")).toBe(true);
    expect(channelAcceptsEvent("prices", "trade")).toBe(false);
    expect(channelAcceptsEvent("me", "order.updated")).toBe(true);
    expect(EVENT_CATALOG["wallet.changed"]).toBe("me");
  });
});

describe("contratos: PATCH /admin/market-maker", () => {
  it("livro 34: aceita os percentuais com motivo e recusa sem motivo ou com valor fora da faixa", () => {
    expect(marketMakerBodySchema.safeParse({ mmQuantityBp: 100, reason: "Poucos jogadores: a casa precisa de mais fôlego" }).success).toBe(true);
    expect(marketMakerBodySchema.safeParse({ mmQuantityBp: 100 }).success).toBe(false);
    expect(marketMakerBodySchema.safeParse({ mmQuantityBp: 100, reason: "  " }).success).toBe(false);
    expect(marketMakerBodySchema.safeParse({ mmQuantityBp: 10_001, reason: "motivo válido" }).success).toBe(false);
    expect(marketMakerBodySchema.safeParse({ mmMinSideQty: 0, reason: "motivo válido" }).success).toBe(false);
    expect(marketMakerBodySchema.safeParse({ reason: "motivo válido" }).success).toBe(false);
    expect(marketMakerBodySchema.safeParse({ mmQuantityBp: 1.5, reason: "motivo válido" }).success).toBe(false);
  });
});
