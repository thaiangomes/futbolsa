import { IPO_ERROR_MESSAGES, type IpoCash, type IpoOverview, type MyBid } from "@futbolsa/contracts";
import { ApiError } from "../../lib/api";

/**
 * A reserva de uma oferta: quantidade × o menor valor entre o preço máximo e o teto da faixa.
 * É a mesma conta de `bidReserve` do motor (`@futbolsa/engine`); o site não importa o motor, então
 * o teste confere as duas contra centenas de casos.
 */
export function bidReserve(quantity: number, maxPrice: number, band: { ceiling: number }): number {
  return quantity * Math.min(maxPrice, band.ceiling);
}

/** Quantidade de ações: inteiro de 1 em diante. Outra coisa é `null` (a tela mostra `invalid_quantity`). */
export function parseQuantity(text: string): number | null {
  const value = text.trim();
  if (!/^\d{1,9}$/.test(value)) return null;
  const quantity = Number(value);
  return quantity >= 1 ? quantity : null;
}

/**
 * Reais digitados (`40`, `40,5`, `40.50`, `R$ 1.234,56`) para centavos inteiros. Mais de duas casas
 * ou valor que não é número é `null` (a tela mostra `invalid_price`). Com vírgula, o ponto é de milhar.
 */
export function parseReais(text: string): number | null {
  let value = text.trim().replace(/^R\$\s*/, "");
  if (value.includes(",")) value = value.replace(/\./g, "").replace(",", ".");
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

/** Centavos como o campo de preço mostra (`4000` vira `40,00`). */
export function reaisField(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });
}

export type BidPreview =
  | {
      ok: true;
      quantity: number;
      /** Preço máximo digitado, em centavos. */
      maxPrice: number;
      /** O preço que vale: o menor entre o máximo e o teto. */
      effectivePrice: number;
      aboveCeiling: boolean;
      reserve: number;
      /** Caixa livre depois da oferta (a reserva atual da mesma oferta conta como livre). Negativo se não cobre. */
      freeAfter: number;
      belowFloor: boolean;
    }
  | { ok: false; quantityError: string | null; priceError: string | null };

/**
 * A prévia da reserva enquanto o jogador digita. Entrada que não vale mostra a mensagem do código
 * do contrato (`invalid_quantity`, `invalid_price`); o resto da conferência (piso, caixa) a API refaz.
 */
export function bidPreview(input: {
  quantity: string;
  maxPrice: string;
  band: { floor: number; ceiling: number };
  freeCash: number;
  currentReserve: number;
}): BidPreview {
  const quantity = parseQuantity(input.quantity);
  const maxPrice = parseReais(input.maxPrice);
  const quantityError = quantity === null && input.quantity.trim() !== "" ? IPO_ERROR_MESSAGES.invalid_quantity : null;
  const priceError = (maxPrice === null || maxPrice <= 0) && input.maxPrice.trim() !== "" ? IPO_ERROR_MESSAGES.invalid_price : null;
  if (quantity === null || maxPrice === null || maxPrice <= 0) return { ok: false, quantityError, priceError };
  const reserve = bidReserve(quantity, maxPrice, input.band);
  return {
    ok: true,
    quantity,
    maxPrice,
    effectivePrice: Math.min(maxPrice, input.band.ceiling),
    aboveCeiling: maxPrice > input.band.ceiling,
    reserve,
    freeAfter: input.freeCash + input.currentReserve - reserve,
    belowFloor: maxPrice < input.band.floor,
  };
}

/** A contagem até o fechamento: só as unidades que importam (`6 d 23 h 12 min 5 s`, `1 min 5 s`). */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return "0 s";
  const total = Math.floor(ms / 1000);
  const parts: Array<[number, string]> = [
    [Math.floor(total / 86_400), "d"],
    [Math.floor(total / 3600) % 24, "h"],
    [Math.floor(total / 60) % 60, "min"],
    [total % 60, "s"],
  ];
  const first = parts.findIndex(([value]) => value > 0);
  return parts.slice(first).map(([value, unit]) => `${value} ${unit}`).join(" ");
}

/**
 * A mensagem de uma recusa. Se o código é do IPO, vale o texto do contrato (o mesmo que a API
 * manda); do contrário, a mensagem que veio no erro.
 */
export function ipoErrorMessage(error: unknown): string {
  if (error instanceof ApiError && Object.hasOwn(IPO_ERROR_MESSAGES, error.code)) {
    return IPO_ERROR_MESSAGES[error.code as keyof typeof IPO_ERROR_MESSAGES];
  }
  return error instanceof Error && error.message ? error.message : "Algo deu errado. Tente de novo.";
}

/** Códigos em que a tela relê o estado da API: o que ela mostra não é mais o que vale. */
export const STALE_CODES: readonly string[] = ["ipo_closed", "ipo_not_open", "bid_exists", "bid_not_found"];

/** O que a API devolveu ao salvar: a oferta do clube e o caixa novos. */
export function applyBidSaved(overview: IpoOverview, ticker: string, bid: MyBid, cash: IpoCash): IpoOverview {
  return { ...overview, cash, clubs: overview.clubs.map((c) => (c.ticker === ticker ? { ...c, myBid: bid } : c)) };
}

/** O que a API devolveu ao cancelar: sem oferta no clube e o caixa novo. */
export function applyBidCancelled(overview: IpoOverview, ticker: string, cash: IpoCash): IpoOverview {
  return { ...overview, cash, clubs: overview.clubs.map((c) => (c.ticker === ticker ? { ...c, myBid: null } : c)) };
}

/** O período de ofertas está aberto para quem tem carteira: `ipo_open` e antes do horário de fechamento. */
export function biddingOpen(overview: IpoOverview, now: number): boolean {
  return overview.status === "ipo_open" && overview.closesAt !== null && now < Date.parse(overview.closesAt);
}
