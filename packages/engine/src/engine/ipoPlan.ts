import { nextDayAt } from "./brasilia.js";

/**
 * Datas do IPO e lote do formador ([[IPO por bookbuilding]]).
 *
 * As ofertas abrem 14 dias e fecham 7 dias antes do horário do primeiro jogo da
 * 1ª rodada do Brasileirão. A negociação abre às 10h de Brasília do dia seguinte
 * ao fechamento. As datas são calculadas na abertura das ofertas e não mudam
 * sozinhas; o admin só pode adiar o fechamento, nunca antecipar.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Hora de Brasília em que a negociação abre, no dia seguinte ao fechamento do IPO. */
export const TRADING_OPENS_HOUR = 10;

export interface IpoDates {
  opensAt: number;
  closesAt: number;
  tradingOpensAt: number;
}

export function ipoDates(firstKickoff: number): IpoDates {
  if (!Number.isFinite(firstKickoff)) throw new Error(`Horário do primeiro jogo inválido: ${firstKickoff}`);
  const closesAt = firstKickoff - 7 * DAY_MS;
  return {
    opensAt: firstKickoff - 14 * DAY_MS,
    closesAt,
    tradingOpensAt: nextDayAt(closesAt, TRADING_OPENS_HOUR),
  };
}

/**
 * Adia o fechamento enquanto as ofertas estão abertas (`now` antes do fechamento
 * atual). A negociação passa a abrir no dia seguinte ao novo fechamento;
 * antecipar é recusado.
 */
export function postponeClose(dates: IpoDates, newClosesAt: number, now: number): IpoDates {
  if (!Number.isFinite(newClosesAt) || !Number.isFinite(now)) throw new Error("Instante inválido");
  if (now >= dates.closesAt) throw new Error("O período de ofertas já fechou: não dá para adiar");
  if (newClosesAt < dates.closesAt) throw new Error("O fechamento do IPO só pode ser adiado, nunca antecipado");
  return {
    opensAt: dates.opensAt,
    closesAt: newClosesAt,
    tradingOpensAt: nextDayAt(newClosesAt, TRADING_OPENS_HOUR),
  };
}

/**
 * Lote do formador: ações emitidas para a tesouraria, sem pagamento, no
 * fechamento do IPO de cada clube. `lotBp` em pontos-base da oferta (1.000 = 10%),
 * arredondado para baixo. O total do clube depois do IPO é oferta + lote.
 */
export function mmLot(offer: number, lotBp: number): number {
  if (!Number.isInteger(offer) || offer <= 0) throw new Error(`Oferta inválida: ${offer}`);
  if (!Number.isInteger(lotBp) || lotBp < 0 || lotBp > 10_000) {
    throw new Error(`Lote em pontos-base inválido: ${lotBp}`);
  }
  return Math.floor((offer * lotBp) / 10_000);
}
