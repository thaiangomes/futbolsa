import type { LiveMatch } from "@futbolsa/engine";

/**
 * Os placares parciais dos jogos em andamento, para os bots (item 23 das melhorias da partida de teste). Na API do jogo não
 * existe fonte de placar parcial: o padrão é nenhum, e o valor justo dos bots é o de sempre. A montagem da partida de teste
 * troca por uma que lê o placar ao vivo da ESPN.
 */
export abstract class PartialScores {
  /** Os jogos que estão sendo disputados no instante, com o placar de agora. */
  abstract at(now: Date): readonly LiveMatch[];
}

export const noPartialScores: PartialScores = { at: () => [] };

/**
 * Os clubes para onde os bots olham primeiro na rodada (item 23, parte 4): os dois do jogo em que acabou de sair um gol, como um
 * torcedor que vai ver o que aconteceu. O valor justo continua o de sempre; só muda onde a atenção cai. Na API do jogo é vazio.
 */
export abstract class AttentionClubs {
  abstract clubs(now: Date): readonly string[];
}

export const noAttention: AttentionClubs = { clubs: () => [] };

/**
 * Traduz os nomes de um placar ao vivo (os da fonte: o ticker do clube listado, ou `EXT-NOME-DO-CLUBE` para o não listado) para os
 * ids que a visão dos bots usa (o ticker, ou `EXT-<id do banco>`). Sem isto o parcial de um jogo de copa contra clube não listado
 * não casava com o jogo gravado e era ignorado. Nome que não achar clube fica como veio.
 */
export function liveWithEngineIds(
  live: readonly LiveMatch[],
  clubRows: readonly { id: number; ticker: string | null; name: string }[],
  normalize: (name: string) => string,
): LiveMatch[] {
  const byName = new Map<string, string>();
  const tickers = new Set<string>();
  for (const c of clubRows) {
    if (c.ticker) tickers.add(c.ticker);
    else byName.set(normalize(c.name), `EXT-${c.id}`);
  }
  const idOf = (name: string): string => (tickers.has(name) ? name : (byName.get(normalize(name)) ?? name));
  return live.map((m) => ({ ...m, home: idOf(m.home), away: idOf(m.away) }));
}
