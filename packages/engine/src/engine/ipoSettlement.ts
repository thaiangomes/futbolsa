import { runBookbuilding } from "./bookbuilding.js";
import { mmLot } from "./ipoPlan.js";
import type { Cents } from "./money.js";

/**
 * Liquidação do IPO de um clube ([[IPO por bookbuilding]], F8): função pura sobre o
 * `runBookbuilding` e o `mmLot`. A API chama uma vez por clube, com as ofertas
 * ativas, e grava o que sair daqui.
 */

export interface IpoBidInput {
  id: number;
  walletId: number;
  quantity: number;
  maxPrice: Cents;
  /** Reserva presa no caixa: quantidade × min(preço máximo, teto). */
  reserved: Cents;
  /** Instante da última alteração (ms): desempata o rateio. */
  updatedAt: number;
}

export interface IpoAllocation {
  bidId: number;
  walletId: number;
  shares: number;
  paid: Cents;
  refunded: Cents;
}

export interface IpoClubSettlement {
  cutPrice: Cents;
  /** Demanda, em ações, no preço de corte (antes do rateio). */
  demandAtCut: number;
  /** Oferta ÷ demanda quando há rateio; 1 ÷ 1 sem rateio. Frações já reduzidas. */
  ratio: { num: number; den: number };
  /** Toda oferta entra, mesmo a não atendida (0 ações e devolução da reserva inteira). */
  allocations: IpoAllocation[];
  /** Ações da oferta que ninguém comprou e ficam com a tesouraria. */
  leftoverShares: number;
  /** Lote do formador: emitido para a tesouraria sem pagamento. */
  lotShares: number;
  /** Ações do clube depois do IPO: oferta + lote. */
  totalShares: number;
  /** Dinheiro que a tesouraria recebe: a soma do que os jogadores pagaram. */
  treasuryCash: Cents;
}

export interface SettleIpoClubInput {
  offer: number;
  /** Faixa fixada na abertura das ofertas. */
  band: { floor: Cents; ceiling: Cents };
  /** Lote do formador em pontos-base da oferta (2.000 = 20%). */
  lotBp: number;
  bids: readonly IpoBidInput[];
}

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

/**
 * Preço de corte, rateio, pagamento, devolução, sobra e lote de um clube.
 *
 * O desempate do rateio é quem alterou a oferta primeiro: ordena por `updatedAt` e
 * depois por `id` antes de chamar o `runBookbuilding`, que desempata pela ordem da
 * lista. Confere por dentro que ninguém paga mais do que reservou, que as ações
 * alocadas mais a sobra são a oferta e que o dinheiro da tesouraria é a soma dos
 * pagamentos.
 */
export function settleIpoClub(input: SettleIpoClubInput): IpoClubSettlement {
  const { offer, band, lotBp } = input;
  const ids = new Set<number>();
  for (const b of input.bids) {
    if (ids.has(b.id)) throw new Error(`Oferta repetida na liquidação: ${b.id}`);
    ids.add(b.id);
  }
  const bids = [...input.bids].sort((a, b) => a.updatedAt - b.updatedAt || a.id - b.id);

  const result = runBookbuilding(
    offer,
    { center: band.floor, min: band.floor, max: band.ceiling },
    bids.map((b) => ({ investorId: String(b.id), quantity: b.quantity, maxPrice: b.maxPrice })),
  );
  const sharesByBid = new Map(result.allocations.map((a) => [a.investorId, a.quantity]));

  let treasuryCash = 0;
  let allocated = 0;
  const allocations: IpoAllocation[] = bids.map((b) => {
    const shares = sharesByBid.get(String(b.id)) ?? 0;
    const paid = shares * result.price;
    if (paid > b.reserved) {
      throw new Error(`A reserva da oferta ${b.id} (${b.reserved}) não cobre o pagamento (${paid})`);
    }
    treasuryCash += paid;
    allocated += shares;
    return { bidId: b.id, walletId: b.walletId, shares, paid, refunded: b.reserved - paid };
  });
  if (allocated + result.treasuryShares !== offer) {
    throw new Error(`Ações alocadas (${allocated}) mais a sobra (${result.treasuryShares}) não somam a oferta (${offer})`);
  }

  const ratio =
    result.demandAtPrice > offer
      ? { num: offer / gcd(offer, result.demandAtPrice), den: result.demandAtPrice / gcd(offer, result.demandAtPrice) }
      : { num: 1, den: 1 };
  const lotShares = mmLot(offer, lotBp);

  return {
    cutPrice: result.price,
    demandAtCut: result.demandAtPrice,
    ratio,
    allocations,
    leftoverShares: result.treasuryShares,
    lotShares,
    totalShares: offer + lotShares,
    treasuryCash,
  };
}
