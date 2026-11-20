import { PLACEMENT_BASELINE, placementWithQualification, type LeagueRules } from "./dividends.js";
import { DEFAULT_BAND_WIDTH, priceBand, suggestedPrice } from "./bookbuilding.js";
import { assertCents, type Cents } from "./money.js";
import { mulDivRound } from "./rounding.js";

/**
 * Faixa de preço e oferta do IPO na Fase 1 ([[IPO por bookbuilding]], F8).
 *
 * Só aritmética inteira: a faixa fixada na abertura das ofertas e a validação de
 * cada oferta (quantidade, preço máximo e reserva no caixa) saem daqui; a API só
 * grava o resultado e trava o dinheiro.
 */

/** Maior quantidade que cabe na coluna `integer` do banco (`ipo_bids.quantity`). */
export const MAX_BID_QUANTITY = 2_147_483_647;

/**
 * Preço de partida do clube pela colocação do ano anterior.
 * - 1 a 20: o preço sugerido da colocação.
 * - 21 a 24: os promovidos, guardados na ordem da Série B, usam os preços do 17º ao 20º
 *   (R$ 9, R$ 7, R$ 5 e R$ 3).
 * - `null`: clube do Clube dos Treze na Série B, que usa o preço do 20º (R$ 3).
 * Qualquer outro valor é erro.
 */
export function placementPrice(placement: number | null): Cents {
  if (placement === null) return suggestedPrice(20);
  if (!Number.isInteger(placement) || placement < 1 || placement > 24) {
    throw new Error(`Colocação inválida para o IPO: ${placement}`);
  }
  return suggestedPrice(placement <= 20 ? placement : placement - 4);
}

export interface IpoBandInput {
  /** Colocação do ano anterior (1 a 24) ou `null` para o Clube dos Treze na Série B. */
  placement: number | null;
  /** Dividendos de copa esperados na data do fechamento (`cupExpected`), em centavos. */
  cupExpected: Cents;
  /** Múltiplo da recompra em pontos-base (15.000 = 1,5×). */
  buybackBp: number;
  /** Largura da faixa em pontos-base: ±40% por padrão. */
  widthBp?: number;
  /**
   * Quanto a colocação rende a mais com a tabela da temporada do que com a tabela de que o preço sugerido partiu
   * (`placementUplift`), em centavos por ação. O dividendo maior sobe o centro da faixa, na mesma proporção da recompra.
   */
  placementUplift?: Cents;
}

export interface IpoBand {
  center: Cents;
  floor: Cents;
  ceiling: Cents;
  /** O preço da colocação, para a tela mostrar a conta. */
  placementPrice: Cents;
  /** A parte das copas no centro: copas esperadas × (1 + recompra). */
  cupsPart: Cents;
}

/**
 * Centro = preço da colocação + copas esperadas × (1 + múltiplo da recompra); piso e
 * teto pela largura da faixa (±40%), arredondados ao centavo.
 * Ex.: R$ 40,00 + R$ 4,22 × 2,5 = R$ 50,55; piso R$ 30,33; teto R$ 70,77.
 */
export function ipoBand(input: IpoBandInput): IpoBand {
  const { placement, cupExpected, buybackBp, widthBp = DEFAULT_BAND_WIDTH * 10_000, placementUplift = 0 } = input;
  assertCents(placementUplift, "aumento da colocação");
  assertCents(cupExpected, "copas esperadas");
  if (cupExpected < 0) throw new Error(`Copas esperadas negativas: ${cupExpected}`);
  if (!Number.isInteger(buybackBp) || buybackBp < 0) throw new Error(`Recompra em pontos-base inválida: ${buybackBp}`);
  if (!Number.isInteger(widthBp) || widthBp < 0 || widthBp > 10_000) {
    throw new Error(`Largura da faixa em pontos-base inválida: ${widthBp}`);
  }
  const base = placementPrice(placement);
  const cupsPart = mulDivRound(cupExpected, 10_000 + buybackBp, 10_000);
  const upliftPart = mulDivRound(placementUplift, 10_000 + buybackBp, 10_000);
  const band = priceBand(base + cupsPart + upliftPart, widthBp / 10_000);
  return { center: band.center, floor: band.min, ceiling: band.max, placementPrice: base, cupsPart };
}

/** Reserva da oferta: quantidade × o menor valor entre o preço máximo e o teto da faixa. */
export function bidReserve(quantity: number, maxPrice: Cents, band: { ceiling: Cents }): Cents {
  return quantity * Math.min(maxPrice, band.ceiling);
}

export type BidRefusal = "invalid_quantity" | "invalid_price" | "below_band_floor" | "insufficient_cash";

export interface ValidateBidInput {
  quantity: number;
  maxPrice: Cents;
  band: { floor: Cents; ceiling: Cents };
  /** Caixa livre da carteira (caixa − reservado), com a reserva desta oferta já descontada. */
  freeCash: Cents;
  /** Reserva atual desta mesma oferta (0 se for nova): conta como livre ao editar. */
  currentReserve: Cents;
}

export type BidValidation =
  | { ok: true; reserve: Cents; /** Reserva nova menos a atual: o que o caixa reservado muda. */ delta: Cents }
  | { ok: false; code: BidRefusal };

/**
 * Confere a oferta, na ordem: quantidade inteira de 1 em diante, preço em centavos
 * inteiros e positivo, preço máximo não abaixo do piso e reserva nova dentro do caixa
 * livre mais a reserva atual da mesma oferta.
 */
export function validateBid(input: ValidateBidInput): BidValidation {
  const { quantity, maxPrice, band, freeCash, currentReserve } = input;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_BID_QUANTITY) {
    return { ok: false, code: "invalid_quantity" };
  }
  if (!Number.isSafeInteger(maxPrice) || maxPrice <= 0) return { ok: false, code: "invalid_price" };
  if (maxPrice < band.floor) return { ok: false, code: "below_band_floor" };
  const reserve = bidReserve(quantity, maxPrice, band);
  if (!Number.isSafeInteger(reserve) || reserve > freeCash + currentReserve) {
    return { ok: false, code: "insufficient_cash" };
  }
  return { ok: true, reserve, delta: reserve - currentReserve };
}

/**
 * O aumento do dividendo de colocação esperado do clube, pela colocação do ano anterior (a mesma regra de `placementPrice`):
 * a tabela da temporada com o bônus de classificação projetado, menos a tabela de 2026 (`PLACEMENT_BASELINE`) de que o preço
 * sugerido partiu. A penalização de rebaixamento fica de fora: é risco que o mercado precifica, não dividendo esperado.
 * Nunca fica negativo (tabela menor que a base não derruba o preço sugerido).
 */
export function placementUplift(placement: number | null, rules: LeagueRules): Cents {
  const rank = placement === null ? 20 : placement <= 20 ? placement : placement - 4;
  return Math.max(0, placementWithQualification(rules, rank) - (PLACEMENT_BASELINE[rank - 1] ?? 0));
}
