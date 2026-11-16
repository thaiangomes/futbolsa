/**
 * Os selos dos clubes: cores, padrão inspirado na camisa e a cor da sigla, como foram aprovados nos protótipos (página
 * "Sistema de design" e componente Selo, 2026-11-01 e 2026-11-02). Selo próprio do FutBolsa, nunca o escudo oficial. É a fonte
 * dos dados: a migração dos clubes, a carga da partida e do ensaio e a tela leem daqui, e um teste confere que o banco e este
 * arquivo dizem o mesmo.
 */

/**
 * Padrões do selo (o desenho de cada um fica na tela):
 * - `solido`: uma cor só; `listras`: listras verticais; `aros`: faixas horizontais finas; `aros-grossos`: quatro faixas
 *   horizontais iguais; `listras-h`: cinco faixas horizontais iguais; `faixa`: uma faixa horizontal no meio;
 * - `tricolor`: faixa fina de duas cores sobre fundo claro; `diagonal`: metade e metade; `faixa-diagonal`: uma faixa na diagonal.
 */
export const BADGE_PATTERNS = ["solido", "listras", "aros", "aros-grossos", "listras-h", "faixa", "tricolor", "diagonal", "faixa-diagonal"] as const;
export type BadgePattern = (typeof BADGE_PATTERNS)[number];

export interface ClubBadgeInfo {
  /** Cor do fundo (a dominante da camisa). */
  primary: string;
  /** Cor do padrão. */
  secondary: string;
  pattern: BadgePattern;
  /** Cor da sigla. */
  ink: string;
  /** Segunda cor do padrão `tricolor` (a faixa de baixo). */
  extra: string | null;
}

const b = (primary: string, secondary: string, pattern: BadgePattern, ink: string, extra: string | null = null): ClubBadgeInfo => ({ primary, secondary, pattern, ink, extra });

/** Os 24 clubes conhecidos, por ticker. A sigla do selo é o começo do ticker (três letras). */
export const CLUB_BADGES: Readonly<Record<string, ClubBadgeInfo>> = {
  CAP3: b("#C8102E", "#111111", "listras-h", "#FFFFFF"),
  CAM3: b("#111111", "#FFFFFF", "listras", "#FFFFFF"),
  BAH3: b("#0057B8", "#D62828", "diagonal", "#FFFFFF"),
  BOT3: b("#111111", "#F2F2F2", "listras", "#FFFFFF"),
  RBB3: b("#F4F4F4", "#D21034", "faixa", "#111111"),
  CHA3: b("#0A7A3B", "#FFFFFF", "solido", "#FFFFFF"),
  COR3: b("#111111", "#FFFFFF", "solido", "#FFFFFF"),
  CFC3: b("#F4F4F4", "#0B6E3A", "aros", "#111111"),
  CRU3: b("#1A3E8C", "#FFFFFF", "solido", "#FFFFFF"),
  FLA3: b("#C8102E", "#111111", "aros-grossos", "#FFFFFF"),
  FLU3: b("#7A1F3D", "#0B6E3A", "listras", "#FFFFFF"),
  GRE3: b("#0D80BF", "#111111", "listras", "#FFFFFF"),
  INT3: b("#C8102E", "#FFFFFF", "solido", "#FFFFFF"),
  MIR3: b("#F2C200", "#0B6E3A", "faixa", "#111111"),
  PAL3: b("#0B6E3A", "#E8F1EC", "solido", "#FFFFFF"),
  REM3: b("#13294B", "#FFFFFF", "solido", "#FFFFFF"),
  SAN3: b("#F4F4F4", "#111111", "solido", "#111111"),
  SAO3: b("#F4F4F4", "#E2231A", "tricolor", "#111111", "#111111"),
  VAS3: b("#111111", "#FFFFFF", "faixa-diagonal", "#FFFFFF"),
  VIT3: b("#C8102E", "#111111", "faixa", "#FFFFFF"),
  FOR3: b("#1D4E9E", "#D62828", "faixa", "#FFFFFF"),
  CEA3: b("#111111", "#F4F4F4", "listras", "#FFFFFF"),
  JUV3: b("#0B7A3E", "#FFFFFF", "faixa", "#FFFFFF"),
  SPT3: b("#C8102E", "#111111", "faixa", "#FFFFFF"),
};

/** A sigla do selo: as três primeiras letras do ticker. */
export const badgeAbbrOf = (ticker: string): string => ticker.slice(0, 3);
