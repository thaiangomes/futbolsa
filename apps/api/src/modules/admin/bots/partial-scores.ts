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
