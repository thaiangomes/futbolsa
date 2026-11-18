import type { LiveGame, LiveGameSide, LiveGames, PriceEvent } from "@futbolsa/contracts";

/** A faixa só aparece com jogo em andamento (Protótipos, "Jogos ao vivo"): sem jogo, some. */
export const showStrip = (data: LiveGames | null): boolean => !!data && data.live.length > 0;

/** A sigla da faixa: as três primeiras letras do ticker (`FLA3` vira `FLA`). */
export const siglaOf = (side: LiveGameSide): string => (side.ticker ?? side.name).slice(0, 3).toUpperCase();

/** A variação do dia como a faixa mostra: `▲3,02%` ou `▼0,86%`; parada, `0,00%`; sem preço, nada. */
export function formatDayChange(changeBp: number | null): string {
  if (changeBp === null) return "";
  const pct = (Math.abs(changeBp) / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${changeBp > 0 ? "▲" : changeBp < 0 ? "▼" : ""}${pct}%`;
}

/** A classe de cor da variação: verde com ▲, vermelho com ▼, apagada parada. */
export const changeTone = (changeBp: number | null): "up" | "down" | "muted" => (changeBp === null || changeBp === 0 ? "muted" : changeBp > 0 ? "up" : "down");

/** O placar `1 × 1`; `– × –` quando o jogo está em andamento e o placar parcial ainda não chegou. */
export const scoreText = (game: LiveGame): string => (game.score ? `${game.score.home} × ${game.score.away}` : "– × –");

/** O minuto como a faixa mostra: `38'`; vazio sem minuto. */
export const minuteText = (game: LiveGame): string => (game.minute === null ? "" : `${game.minute}'`);

/** O tempo do jogo para o cartão: `1º tempo · 38'` (o intervalo, com o minuto em 45, aparece como 1º tempo). */
export function phaseText(game: LiveGame): string {
  if (game.minute === null) return "Em andamento";
  return `${game.minute <= 45 ? "1º tempo" : "2º tempo"} · ${game.minute}'`;
}

/** Quantos jogos em andamento, no texto da faixa recolhida: `5 jogos ao vivo` ou `1 jogo ao vivo`. */
export const liveCountText = (n: number): string => `${n} ${n === 1 ? "jogo" : "jogos"} ao vivo`;

const withPrice = (side: LiveGameSide, event: PriceEvent): LiveGameSide => (side.ticker === event.ticker ? { ...side, price: event.price, changeBp: event.changeBp } : side);
const gameWithPrice = (g: LiveGame, event: PriceEvent): LiveGame => ({ ...g, home: withPrice(g.home, event), away: withPrice(g.away, event) });

/** Aplica um evento `price` do canal `prices` ao preço e à variação do clube em todos os jogos (o placar só muda na releitura). */
export function applyPriceToGames(data: LiveGames, event: PriceEvent): LiveGames {
  const apply = (list: LiveGame[]) => list.map((g) => gameWithPrice(g, event));
  return { live: apply(data.live), upcoming: apply(data.upcoming), finished: apply(data.finished), next: data.next ? gameWithPrice(data.next, event) : null };
}

/** O endereço do Mercado do clube, ou `null` para clube que não é listado. */
export const clubHref = (side: LiveGameSide): string | null => (side.ticker ? `/clube?t=${encodeURIComponent(side.ticker)}` : null);
