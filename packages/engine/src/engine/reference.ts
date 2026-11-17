import { dayStart } from "./brasilia.js";
import { assertCents, MIN_PRICE, type Cents } from "./money.js";

/**
 * Referência que decai (rodada Z de Calibração, 2026-11-15; decisão do Thaian). Quando um clube fica sem negócio e
 * o preço exibido está longe do valor justo da casa, vendedores só pedem perto do preço e compradores só pagam
 * perto do valor justo, e a faixa de 20% recusa a compra: ninguém cruza e o preço não anda. A referência usada na
 * faixa de 20%, no túnel e na regra de nunca ser melhor que o mercado anda do último preço em direção ao valor
 * justo, 10% por dia sem negócio depois de uma carência, e para no valor justo. O preço exibido continua sendo o
 * do último negócio; qualquer negócio volta a referência para ele.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Passo diário: igual à largura do túnel (10%). */
export const REFERENCE_DECAY_STEP_BP = 1000;
/** Carência: só começa a decair depois de 2 dias inteiros sem negócio (tempo decorrido, não dia civil). */
export const REFERENCE_GRACE_MS = 2 * DAY_MS;
/**
 * Só decai quando o último preço está a mais de 10% do valor justo, para qualquer lado. Era 20% e deixava uma brecha:
 * com o preço entre 14% e 20% abaixo do justo, a venda da casa (justo × 1,05) passava do teto da faixa e ninguém a alcançava
 * (PAL3 na partida de teste, um mês parado, rodada Z parte 3).
 */
export const REFERENCE_MIN_GAP_BP = 1000;

/** Dias inteiros sem negócio, por dia civil de Brasília (limitado a 60 para a conta ser curta). */
export function staleDays(lastTradeAt: number, now: number): number {
  const days = Math.round((dayStart(now) - dayStart(lastTradeAt)) / DAY_MS);
  return Math.max(0, Math.min(60, days));
}

/**
 * Anda do último preço em direção ao valor justo, em conta inteira: a cada dia o preço perde (ou ganha) `stepBp`,
 * sem passar do valor justo e nunca abaixo de R$ 0,50.
 */
export function decayedReference(lastPrice: Cents, fair: Cents, days: number, stepBp: number = REFERENCE_DECAY_STEP_BP): Cents {
  assertCents(lastPrice, "último preço");
  assertCents(fair, "valor justo");
  let r = lastPrice;
  for (let i = 0; i < days && r !== fair; i++) {
    r = r > fair ? Math.max(fair, Math.ceil((r * (10_000 - stepBp)) / 10_000)) : Math.min(fair, Math.floor((r * 10_000) / (10_000 - stepBp)));
  }
  return Math.max(MIN_PRICE, r);
}

export interface ReferenceInput {
  /** Preço exibido: o do último negócio (antes dele, o do IPO). */
  lastPrice: Cents;
  /** Instante do último negócio; sem ele (nenhum negócio ainda) não há decaimento. */
  lastTradeAt: number | null;
  /** Valor justo da casa agora. */
  fair: Cents;
  now: number;
  /** Distância mínima ao valor justo para decair, em pontos-base; sem ela, `REFERENCE_MIN_GAP_BP`. */
  minGapBp?: number;
}

/**
 * A referência decaída do clube, ou `null` quando vale o preço exibido: menos de 2 dias sem negócio, clube sem
 * negócio ainda, ou preço a até 10% do valor justo. É função pura do estado: a API só a grava em `reference_price`
 * a cada reposição da casa e a apaga a cada negócio.
 */
export function nextReference(input: ReferenceInput): Cents | null {
  const { lastPrice, lastTradeAt, fair, now } = input;
  const gap = input.minGapBp ?? REFERENCE_MIN_GAP_BP;
  if (lastTradeAt === null) return null;
  const idle = now - lastTradeAt;
  if (idle < REFERENCE_GRACE_MS) return null;
  const near = lastPrice * 10_000 <= fair * (10_000 + gap) && lastPrice * 10_000 >= fair * (10_000 - gap);
  if (near) return null;
  const days = Math.min(60, Math.floor((idle - REFERENCE_GRACE_MS) / DAY_MS) + 1);
  const reference = decayedReference(lastPrice, Math.max(MIN_PRICE, fair), days);
  return reference === lastPrice ? null : reference;
}
