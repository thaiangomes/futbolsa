import type { CupRules, LeagueRules } from "./dividends.js";

/**
 * Valores de dividendos de uma temporada, que no jogo vêm do banco
 * (`season_rules`, `cup_phases`) e não do código ([[Dividendos e recompra]]).
 * Reaproveita os tipos de `dividends.ts`: `BRASILEIRAO_A`, `BRASILEIRAO_B` e as
 * tabelas das copas de 2025 são só os valores iniciais que o admin copia.
 */
export interface SeasonValues {
  /** Por competição (`brasileirao-a`, `brasileirao-b`): R$ por ponto e tabela de colocação ou de acesso. */
  leagues: Readonly<Record<string, LeagueRules>>;
  /** Por competição (`copa-do-brasil`, `libertadores`, `sulamericana`): fases que pagam e o título. */
  cups: Readonly<Record<string, CupRules>>;
}
