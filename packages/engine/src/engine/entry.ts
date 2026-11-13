import { indexPortfolio, type IndexPortfolio } from "./indexPortfolio.js";
import type { Cents } from "./money.js";
import { leagueClosedAt } from "./payoutEvents.js";
import type { Match } from "./types.js";

/** Nome da Série A nos jogos. */
export const ENTRY_LEAGUE = "brasileirao-a";

/**
 * Entrada no meio da temporada ([[Entrada no meio da temporada]]): a janela, o preço de referência e a conta da
 * prévia. Funções puras; quem lê o banco, trava os clubes e grava é o módulo `entry` da API.
 */

/**
 * `not_scheduled`: não há jogo da Série A no calendário (nada para dizer quando a janela fecha);
 * `open`: a Série A ainda tem jogo a disputar; `closed`: a Série A fechou (fim do último jogo, inclusive os adiados).
 */
export type EntryWindowState = "not_scheduled" | "open" | "closed";

export interface EntryWindow {
  state: EntryWindowState;
  /** O instante em que a Série A fechou (ms desde 1970), quando `state` é `closed`. */
  closedAt?: number;
}

/**
 * A entrada fecha quando o Brasileirão da Série A fecha: o fim do último jogo, contando os adiados disputados depois
 * da última rodada (decisão D1 do Plano da entrada no meio da temporada, o mesmo instante `closedAt` de `eventsFor`).
 * Calculada a cada chamada a partir dos jogos, sem estado gravado. Sem jogos da Série A a janela não tem fim
 * conhecido (`not_scheduled`) e conta como aberta para quem a usa.
 */
export function entryWindow(matches: readonly Match[], now: number): EntryWindow {
  const league = matches.filter((m) => m.competition === ENTRY_LEAGUE);
  if (league.length === 0) return { state: "not_scheduled" };
  const closedAt = leagueClosedAt(league);
  if (closedAt !== undefined && now >= closedAt) return { state: "closed", closedAt };
  return { state: "open" };
}

/**
 * O preço de referência de um clube: o último negócio; antes do primeiro, o preço do IPO. Na prática a liquidação
 * do IPO grava o preço de corte em `last_price`, então vale `last_price`; o `ipoPrice` é a rede de segurança.
 */
export function referencePrice(club: { lastPrice: Cents | null; ipoPrice: Cents | null }): Cents {
  const price = club.lastPrice ?? club.ipoPrice;
  if (price === null) throw new Error("clube sem último negócio nem preço de IPO: não há preço de referência");
  return price;
}

export interface EntryQuote extends Omit<IndexPortfolio, "clubs"> {
  clubCount: number;
  /** Uma linha por clube, em ordem de ticker. */
  clubs: { ticker: string; price: Cents; shares: number }[];
}

/**
 * A conta da prévia e da confirmação (mesma função): a carteira índice sobre os preços de referência por ticker.
 * Soma acima de R$ 70.000,00 dá `n = 0` (só caixa, critério 16); preço abaixo de R$ 0,50 é erro.
 */
export function entryQuote(prices: Readonly<Record<string, Cents>>): EntryQuote {
  const { clubs, ...rest } = indexPortfolio(prices);
  return {
    ...rest,
    clubCount: clubs.length,
    clubs: clubs
      .map((c) => ({ ticker: c.clubId, price: c.costPerShare, shares: c.shares }))
      .sort((a, b) => (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0)),
  };
}
