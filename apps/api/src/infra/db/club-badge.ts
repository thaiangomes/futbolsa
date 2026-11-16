import { badgeAbbrOf, CLUB_BADGES } from "@futbolsa/engine/data/clubBadges";

/**
 * As colunas do selo de um clube (cores, sigla, padrão e cor da sigla), a partir do arquivo versionado do motor
 * (`CLUB_BADGES`). Clube sem selo aprovado fica sem cores (a tela mostra o selo neutro). Usado pela carga dos clubes do `seed`,
 * da partida e do ensaio; a migração 0006 grava os mesmos valores nos clubes que já existiam.
 */
export function badgeColumns(ticker: string) {
  const badge = CLUB_BADGES[ticker];
  if (!badge) return {};
  return {
    colorPrimary: badge.primary,
    colorSecondary: badge.secondary,
    badgeAbbr: badgeAbbrOf(ticker),
    badgePattern: badge.pattern,
    badgeInk: badge.ink,
    badgeExtra: badge.extra,
  };
}
