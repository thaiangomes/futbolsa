import { dayStart } from "./brasilia.js";
import { assertCents, MIN_PRICE, type Cents } from "./money.js";
import type { TradingBand } from "./orderRules.js";

/**
 * Túnel de preço e leilão (especificação "Livro de ofertas e formador de mercado", seção "Túnel de preço e
 * leilão"; P9 e P13 do Plano do livro de ofertas e formador). Em vez de deixar o preço subir 20% a cada
 * negócio, um negócio que fuja demais do preço do dia não executa e o clube entra em leilão.
 *
 * Aqui ficam só as contas puras; quem grava o leilão e casa o preço único é a API, e o preço único está em
 * `auction.ts`.
 */

/** Largura do túnel em pontos-base: 10% para cima e para baixo da referência (rodada X de Calibração). */
export const TUNNEL_BP = 1000;

/** Duração do leilão a partir da ordem que o abriu: 3 horas. */
export const AUCTION_DURATION_MS = 3 * 60 * 60 * 1000;

/**
 * O túnel em volta da referência: de 10% abaixo a 10% acima, arredondado para dentro (para cima embaixo, para
 * baixo em cima) e nunca abaixo de R$ 0,50. Em conta inteira, sem ponto flutuante.
 */
export function tunnelBand(reference: Cents): TradingBand {
  assertCents(reference, "referência do túnel");
  return {
    min: Math.max(MIN_PRICE, Math.ceil((reference * (10_000 - TUNNEL_BP)) / 10_000)),
    max: Math.floor((reference * (10_000 + TUNNEL_BP)) / 10_000),
  };
}

/**
 * Se algum dos negócios sairia fora do túnel. Um só basta: a ordem que executaria **alguma parte** fora dele não
 * executa nada e abre o leilão (critério 39). O preço na beira do túnel está dentro.
 */
export function breachesTunnel(fills: readonly { price: Cents }[], band: TradingBand): boolean {
  return fills.some((f) => f.price < band.min || f.price > band.max);
}

/** O que a linha travada do clube guarda sobre a referência (`tunnel_ref` e `tunnel_ref_day`). */
export interface TunnelState {
  /** Vazia até a primeira ordem do clube. */
  reference: Cents | null;
  /** 0h de Brasília (ms) do dia da referência; vazia junto com `reference`. */
  referenceDay: number | null;
  /** O clube está em leilão (aberto ou parado pela suspensão): a referência não vira. */
  inAuction: boolean;
}

export interface RolledTunnel {
  reference: Cents;
  referenceDay: number;
  /** Se a linha do clube precisa ser gravada (a referência ou o dia mudaram). */
  changed: boolean;
}

/**
 * A referência do túnel é o preço exibido às 0h de Brasília (na estreia, o preço de corte do IPO). Sem tarefa
 * às 0h: toda transação que pode executar chama isto, com o clube travado, e a referência vira no primeiro
 * uso do dia novo, com o preço exibido que o clube tinha (nenhum negócio sai antes de a referência virar, então
 * o preço lido agora é o das 0h). Um clube em leilão mantém a referência que tinha (critério 44); o leilão que
 * termina sem negócio grava o dia de hoje sem mudar a referência (D4), e ela só vira nas 0h seguintes.
 */
export function rollTunnelReference(state: TunnelState, displayedPrice: Cents, now: number): RolledTunnel {
  assertCents(displayedPrice, "preço exibido");
  const today = dayStart(now);
  if (state.reference !== null && state.referenceDay !== null && (state.inAuction || state.referenceDay >= today)) {
    return { reference: state.reference, referenceDay: state.referenceDay, changed: false };
  }
  return { reference: displayedPrice, referenceDay: today, changed: true };
}
