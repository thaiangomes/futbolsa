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
