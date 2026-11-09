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
