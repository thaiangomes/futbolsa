import { assertCents, type Cents } from "./money.js";
import type { Side } from "./orderbook.js";

/**
 * Fim do leilão: preço único (especificação "Livro de ofertas e formador de mercado", seção "Túnel de preço e
 * leilão", critérios 40 e 42; tarefa L2 e decisão D3 do Plano do livro de ofertas e formador).
 *
 * Quando o leilão termina, todas as ordens abertas do clube, as que estavam no livro e as que entraram no leilão,
 * casam num preço só. Função pura: recebe as ordens e a referência do túnel e devolve o preço, os negócios e o que
 * sobra de cada ordem; quem grava (e liquida, devolvendo ao comprador a diferença entre o limite e o preço do
 * leilão) é a API, no `closeAuction`, com o clube travado.
 *
 * Precondição: o mesmo dono nunca tem ordens dos dois lados que se cruzem, porque a API recusa a ordem contra si
 * mesmo, inclusive durante o leilão. Por isso a função não procura nem pula negócio de alguém consigo mesmo.
 */

/** Uma ordem limitada aberta do clube, com o que ainda falta executar. Mesmo formato do `RestingOrder`. */
export interface AuctionOrder {
  /** Crescente na ordem de chegada: no mesmo preço, o menor id casa primeiro. */
  id: number;
  /** O dono, para quem chama mapear o negócio para as carteiras. */
  accountId: string;
  side: Side;
  /** Preço limite, em centavos. */
  limitPrice: Cents;
  /** Quantidade que falta executar (maior que zero). */
  remaining: number;
}

/** Um negócio do leilão: um par compra × venda, sempre no preço único. */
export interface AuctionFill {
  buyOrderId: number;
  sellOrderId: number;
  buyerId: string;
  sellerId: string;
  price: Cents;
  quantity: number;
}

export interface AuctionResult {
  /** O preço único; `null` quando nenhuma compra alcança uma venda (o leilão acaba sem negócio). */
  price: Cents | null;
  /** Quantidade total negociada (zero sem negócio). */
  volume: number;
  /** Na ordem em que saem: compras por preço (maior primeiro) e chegada, contra vendas por preço (menor) e chegada. */
  fills: AuctionFill[];
  /** O que sobra de cada ordem recebida, por id (zero na que terminou), em ordem de id. */
  remaining: Map<number, number>;
}

/**
 * Acha o preço único e os negócios do fim do leilão.
 *
 * Os candidatos são os preços limite das ordens. Num preço p, a demanda é a soma das compras com limite ≥ p, a
 * oferta é a soma das vendas com limite ≤ p e a quantidade negociada é a menor das duas. Vence:
 * 1. a maior quantidade;
 * 2. no empate, a menor sobra (a diferença entre demanda e oferta);
 * 3. depois, o preço mais perto da referência do túnel;
 * 4. se ainda empatar, o menor preço (D3), para o resultado ser sempre o mesmo.
 *
 * Um preço entre dois limites nunca negocia mais que os limites em volta (demanda e oferta só mudam num limite),
 * então olhar só os limites não perde quantidade. Todos os negócios saem ao preço único; a sobra fica no livro e
 * nunca fica cruzada (se ficasse, o limite da compra que sobrou negociaria mais).
 *
 * Não depende da ordem do array recebido: ordena por dentro, por preço e id.
 */
export function clearAuction(orders: readonly AuctionOrder[], reference: Cents): AuctionResult {
  assertCents(reference, "referência do leilão");
  const seen = new Set<number>();
  for (const o of orders) {
    if (!Number.isSafeInteger(o.id)) throw new Error(`id de ordem inválido: ${o.id}`);
    if (seen.has(o.id)) throw new Error(`ordem ${o.id} repetida no leilão`);
    seen.add(o.id);
    assertCents(o.limitPrice, `preço limite da ordem ${o.id}`);
    if (o.limitPrice <= 0) throw new Error(`preço limite da ordem ${o.id} deve ser positivo, recebido ${o.limitPrice}`);
    if (!Number.isSafeInteger(o.remaining) || o.remaining <= 0) {
      throw new Error(`quantidade da ordem ${o.id} deve ser um inteiro positivo, recebido ${o.remaining}`);
    }
  }

  // Prioridade de preço e depois de chegada: compras do maior limite para o menor, vendas do menor para o maior.
  const buys = orders.filter((o) => o.side === "buy").sort((a, b) => b.limitPrice - a.limitPrice || a.id - b.id);
  const sells = orders.filter((o) => o.side === "sell").sort((a, b) => a.limitPrice - b.limitPrice || a.id - b.id);

  const remaining = new Map<number, number>();
  for (const o of [...orders].sort((a, b) => a.id - b.id)) remaining.set(o.id, o.remaining);

  const price = chooseAuctionPrice(buys, sells, reference);
  if (price === null) return { price: null, volume: 0, fills: [], remaining };

  // Caminha pelas duas listas ao mesmo tempo, só com as ordens que aceitam o preço único. Uma ordem pode gerar
  // vários negócios; cada par compra × venda gera um, com a quantidade que der.
  const fills: AuctionFill[] = [];
  let volume = 0;
  let i = 0;
  let j = 0;
  while (i < buys.length && j < sells.length) {
    const b = buys[i]!;
    const s = sells[j]!;
    if (b.limitPrice < price || s.limitPrice > price) break;
    const quantity = Math.min(remaining.get(b.id)!, remaining.get(s.id)!);
    fills.push({ buyOrderId: b.id, sellOrderId: s.id, buyerId: b.accountId, sellerId: s.accountId, price, quantity });
    volume += quantity;
    remaining.set(b.id, remaining.get(b.id)! - quantity);
    remaining.set(s.id, remaining.get(s.id)! - quantity);
    if (remaining.get(b.id) === 0) i++;
    if (remaining.get(s.id) === 0) j++;
  }
  return { price, volume, fills, remaining };
}

/**
 * O preço único pelos critérios de `clearAuction`, ou `null` quando nenhum preço negocia. Recebe as compras em
 * ordem de limite decrescente e as vendas em ordem crescente; conta demanda e oferta acumuladas em uma passada.
 */
function chooseAuctionPrice(buys: readonly AuctionOrder[], sells: readonly AuctionOrder[], reference: Cents): Cents | null {
  const prices = [...new Set([...buys, ...sells].map((o) => o.limitPrice))].sort((a, b) => a - b);

  // Oferta acumulada subindo o preço (vendas com limite ≤ p).
  const supply = new Map<Cents, number>();
  let s = 0;
  let k = 0;
  for (const p of prices) {
    while (k < sells.length && sells[k]!.limitPrice <= p) s += sells[k++]!.remaining;
    supply.set(p, s);
  }

  // Demanda acumulada descendo o preço (compras com limite ≥ p), comparando cada candidato com o melhor até aqui.
  let best: { price: Cents; volume: number; imbalance: number; distance: number } | null = null;
  let d = 0;
  k = 0;
  for (let n = prices.length - 1; n >= 0; n--) {
    const p = prices[n]!;
    while (k < buys.length && buys[k]!.limitPrice >= p) d += buys[k++]!.remaining;
    const sp = supply.get(p)!;
    const candidate = { price: p, volume: Math.min(d, sp), imbalance: Math.abs(d - sp), distance: Math.abs(p - reference) };
    if (best === null || betterPrice(candidate, best)) best = candidate;
  }
  return best !== null && best.volume > 0 ? best.price : null;
}

function betterPrice(
  a: { price: Cents; volume: number; imbalance: number; distance: number },
  b: { price: Cents; volume: number; imbalance: number; distance: number },
): boolean {
  if (a.volume !== b.volume) return a.volume > b.volume;
  if (a.imbalance !== b.imbalance) return a.imbalance < b.imbalance;
  if (a.distance !== b.distance) return a.distance < b.distance;
  return a.price < b.price;
}
