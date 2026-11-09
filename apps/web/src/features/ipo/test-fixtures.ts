import type { IpoClubView, IpoOverview } from "@futbolsa/contracts";
import type { IpoApi } from "./api";

/** Horários de Brasília do exemplo da especificação: abre 2027-03-28 às 16h, fecha 2027-04-04 às 16h. */
export const OPENS_AT = "2027-03-28T19:00:00.000Z";
export const CLOSES_AT = "2027-04-04T19:00:00.000Z";
export const TRADING_AT = "2027-04-05T13:00:00.000Z";

/** FLA3 do critério 5: colocação R$ 40,00, copas R$ 10,55, centro R$ 50,55, piso R$ 30,33, teto R$ 70,77. */
export const FLA3: IpoClubView = {
  ticker: "FLA3",
  name: "Flamengo",
  band: { floor: 3033, center: 5055, ceiling: 7077, placementPrice: 4000, cupsPart: 1055 },
  myBid: null,
};

export const PAL3: IpoClubView = {
  ticker: "PAL3",
  name: "Palmeiras",
  band: { floor: 2700, center: 4500, ceiling: 6300, placementPrice: 4500, cupsPart: 0 },
  myBid: null,
};

export const CASH_FREE = { total: 10_000_000, reserved: 0, free: 10_000_000 };

export function openOverview(overrides: Partial<IpoOverview> = {}): IpoOverview {
  return {
    status: "ipo_open",
    offerSize: 3000,
    opensAt: OPENS_AT,
    closesAt: CLOSES_AT,
    tradingOpensAt: TRADING_AT,
    clubs: [FLA3, PAL3],
    cash: CASH_FREE,
    ...overrides,
  };
}

/** Um instante dentro do período de ofertas (2027-04-01 12h de Brasília). */
export const NOW_OPEN = Date.parse("2027-04-01T15:00:00.000Z");

export const fakeApi = (overrides: Partial<Record<keyof IpoApi, unknown>>) => overrides as unknown as IpoApi;
