import type { LiveMatch } from "@futbolsa/engine";

/**
 * Os placares parciais dos jogos em andamento, para a faixa e a página dos jogos ao vivo (item 25 da fila da partida de
 * teste). A API do jogo não tem fonte de placar parcial: o padrão é nenhum, e o jogo em andamento aparece sem placar. A
 * montagem da partida de teste troca por uma que lê o placar baixado da ESPN (o mesmo que os bots leem). `home` e `away`
 * são os tickers.
 */
export abstract class LiveScores {
  abstract at(now: Date): readonly LiveMatch[];
}

export const noLiveScores: LiveScores = { at: () => [] };
