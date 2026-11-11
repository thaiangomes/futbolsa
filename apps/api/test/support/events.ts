/**
 * Cargas válidas dos eventos `wallet.changed`, `entry.added` e `season.status`, para os testes do tempo real
 * que só precisam de "um evento qualquer" no canal. Esses tipos têm esquema registrado pelo módulo `ipo`
 * (F8), então uma carga inventada é recusada pelo barramento da aplicação inteira.
 */
export const walletChangedData = (cash: number) => ({ cash, reserved: 0, club: null, version: 1 });

export const entryAddedData = (n: number) => ({
  version: n,
  at: "2027-04-01T13:00:00.000Z",
  kind: "ipo_reserve",
  ticker: null,
  cashDelta: 0,
  reservedCashDelta: 0,
  sharesDelta: 0,
  price: null,
  cashAfter: 10_000_000,
});

export const seasonStatusData = (status: "ipo_open" | "ipo_closed" = "ipo_open") => ({
  seasonId: 1,
  status,
  ipoClosesAt: null,
  tradingOpensAt: null,
});

/** Um `trade` válido (esquema do mercado, F9): `id`, hora, preço e quantidade, sem contraparte. */
export const tradeData = (id: number) => ({ id, at: "2027-04-01T13:00:00.000Z", price: 4000, quantity: 1 });

/** Um `price` válido do canal `prices`. */
export const priceData = (price: number) => ({ ticker: "FLA3", price, changeBp: 0, auction: null });

/** Um `order.updated` válido do canal `me`. */
export const orderUpdatedData = (id: number) => ({
  id,
  ticker: "FLA3",
  side: "buy" as const,
  type: "limit" as const,
  quantity: 10,
  filled: 0,
  limitPrice: 4000,
  reservedCash: 40_000,
  status: "open" as const,
  cancelReason: null,
});
