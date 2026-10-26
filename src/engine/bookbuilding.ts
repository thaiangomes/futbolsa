import { assertCents, type Cents } from "./money.js";

/**
 * Bookbuilding do IPO: leilão de preço único com faixa mínima e máxima.
 *
 * - O centro da faixa é o preço sugerido pela colocação do ano anterior.
 * - Preço justo = o maior preço da faixa em que a demanda acumulada
 *   (todas as intenções com preço máximo >= p) cobre a oferta.
 * - Todos pagam o mesmo preço, como na B3.
 * - Se a demanda passa da oferta nesse preço, há rateio proporcional
 *   na quantidade pedida (não no preço).
 * - Se faltar demanda no preço mínimo, a sobra vai para a tesouraria.
 */

/** Preço sugerido pela colocação no Brasileirão anterior (1º a 20º). */
export function suggestedPrice(position: number): Cents {
  if (!Number.isInteger(position) || position < 1 || position > 20) {
    throw new Error(`Colocação inválida: ${position}`);
  }
  // 1º R$ 50, 2º 45, 3º 40, 4º 35; depois −R$ 2 por posição até R$ 3 no 20º.
  if (position <= 4) return 5000 - (position - 1) * 500;
  return 3500 - (position - 4) * 200;
}

export interface PriceBand {
  center: Cents;
  min: Cents;
  max: Cents;
}

export const DEFAULT_BAND_WIDTH = 0.4;

export function priceBand(center: Cents, width = DEFAULT_BAND_WIDTH): PriceBand {
  assertCents(center, "centro da faixa");
  return {
    center,
    min: Math.round(center * (1 - width)),
    max: Math.round(center * (1 + width)),
  };
}

export interface Bid {
  investorId: string;
  quantity: number;
  /** Preço máximo que o investidor aceita pagar, em centavos. */
  maxPrice: Cents;
}

export interface Allocation {
  investorId: string;
  quantity: number;
  cost: Cents;
}

export interface BookbuildingResult {
  price: Cents;
  allocations: Allocation[];
  /** Ações que ninguém comprou e ficam com a tesouraria do jogo. */
  treasuryShares: number;
  /** Demanda total (em ações) válida no preço final, antes do rateio. */
  demandAtPrice: number;
  /** Fração atendida de cada pedido quando há rateio (1 = sem rateio). */
  fillRatio: number;
}

export function runBookbuilding(
  offerShares: number,
  band: PriceBand,
  bids: readonly Bid[],
): BookbuildingResult {
  if (!Number.isInteger(offerShares) || offerShares <= 0) {
    throw new Error(`Oferta inválida: ${offerShares}`);
  }
  // Intenções abaixo do mínimo da faixa não participam; acima do máximo
  // valem como se fossem no máximo (o investidor aceita qualquer preço da faixa).
  const valid = bids
    .filter((b) => b.quantity > 0 && b.maxPrice >= band.min)
    .map((b, order) => ({ ...b, order, cap: Math.min(b.maxPrice, band.max) }));
  for (const b of valid) {
    if (!Number.isInteger(b.quantity)) throw new Error(`Quantidade inválida de ${b.investorId}`);
    assertCents(b.maxPrice, `preço máximo de ${b.investorId}`);
  }

  const demandAt = (price: Cents) =>
    valid.reduce((sum, b) => (b.cap >= price ? sum + b.quantity : sum), 0);

  // A demanda acumulada só muda nos preços das intenções, então basta testar
  // esses pontos (do maior para o menor) para achar o maior preço que cobre a oferta.
  const candidates = [...new Set(valid.map((b) => b.cap))].sort((a, b) => b - a);
  let price = band.min;
  for (const candidate of candidates) {
    if (demandAt(candidate) >= offerShares) {
      price = candidate;
      break;
    }
  }

  const eligible = valid.filter((b) => b.cap >= price);
  const demand = demandAt(price);

  if (demand <= offerShares) {
    return {
      price,
      allocations: eligible.map((b) => ({
        investorId: b.investorId,
        quantity: b.quantity,
        cost: b.quantity * price,
      })),
      treasuryShares: offerShares - demand,
      demandAtPrice: demand,
      fillRatio: 1,
    };
  }

  // Rateio: cada um recebe a mesma fração do que pediu. As ações que sobram do
  // arredondamento para baixo vão para os maiores restos e, no empate, para quem
  // registrou a intenção primeiro.
  // Conta em inteiros (quantidade × oferta ÷ demanda) para o rateio ser exato.
  const ratio = offerShares / demand;
  const shares = eligible.map((b) => {
    const numerator = b.quantity * offerShares;
    const remainder = numerator % demand;
    return { bid: b, quantity: (numerator - remainder) / demand, remainder };
  });
  let leftover = offerShares - shares.reduce((s, x) => s + x.quantity, 0);
  const byRemainder = [...shares].sort(
    (a, b) => b.remainder - a.remainder || a.bid.order - b.bid.order,
  );
  for (const s of byRemainder) {
    if (leftover === 0) break;
    s.quantity += 1;
    leftover -= 1;
  }

  return {
    price,
    allocations: shares
      .filter((s) => s.quantity > 0)
      .map((s) => ({
        investorId: s.bid.investorId,
        quantity: s.quantity,
        cost: s.quantity * price,
      })),
    treasuryShares: 0,
    demandAtPrice: demand,
    fillRatio: ratio,
  };
}
