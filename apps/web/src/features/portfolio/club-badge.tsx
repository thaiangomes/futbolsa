import { badgeAbbrOf, CLUB_BADGES, type ClubBadgeInfo } from "@futbolsa/engine/data/clubBadges";

/** O que o selo pede do clube: o ticker e o nome, e as cores, o padrão e a sigla quando a tela os tem (a carteira os traz do banco). */
export interface BadgeClub {
  ticker: string;
  name: string;
  badgeAbbr?: string | null;
  colorPrimary?: string | null;
  colorSecondary?: string | null;
  badgePattern?: string | null;
  badgeInk?: string | null;
  badgeExtra?: string | null;
}

/** O selo neutro de quem não tem cores aprovadas (nada de escudo, nunca). */
const NEUTRAL: ClubBadgeInfo = { primary: "#5B6676", secondary: "#2A3342", pattern: "solido", ink: "#FFFFFF", extra: null };

/** As cores e o padrão do clube: os do banco, quando vieram; senão os do arquivo versionado pelo ticker; senão o neutro. */
export function badgeOf(club: BadgeClub): ClubBadgeInfo {
  if (club.colorPrimary) {
    const fallback = CLUB_BADGES[club.ticker];
    return {
      primary: club.colorPrimary,
      secondary: club.colorSecondary ?? NEUTRAL.secondary,
      pattern: (club.badgePattern as ClubBadgeInfo["pattern"] | null | undefined) ?? fallback?.pattern ?? "solido",
      ink: club.badgeInk ?? fallback?.ink ?? "#FFFFFF",
      extra: club.badgeExtra ?? fallback?.extra ?? null,
    };
  }
  return CLUB_BADGES[club.ticker] ?? NEUTRAL;
}

const gradient = (angle: string, stops: string) => `linear-gradient(${angle},${stops})`;

/** O fundo do selo para cada padrão, na conta dos protótipos (componente Selo). */
export function badgeBackground(badge: ClubBadgeInfo): string {
  const a = badge.primary;
  const b = badge.secondary;
  switch (badge.pattern) {
    case "listras":
      return gradient("90deg", `${a} 0 22%,${b} 22% 36%,${a} 36% 64%,${b} 64% 78%,${a} 78% 100%`);
    case "aros":
      return gradient("180deg", `${a} 0 24%,${b} 24% 36%,${a} 36% 64%,${b} 64% 76%,${a} 76% 100%`);
    case "aros-grossos":
      return gradient("180deg", `${a} 0 25%,${b} 25% 50%,${a} 50% 75%,${b} 75% 100%`);
    case "listras-h":
      return gradient("180deg", `${a} 0 20%,${b} 20% 40%,${a} 40% 60%,${b} 60% 80%,${a} 80% 100%`);
    case "faixa":
      return gradient("180deg", `${a} 0 34%,${b} 34% 66%,${a} 66% 100%`);
    case "tricolor":
      return gradient("180deg", `${a} 0 36%,${b} 36% 45%,${a} 45% 51%,${badge.extra ?? "#111111"} 51% 60%,${a} 60% 100%`);
    case "diagonal":
      return gradient("135deg", `${a} 0 52%,${b} 52% 100%`);
    case "faixa-diagonal":
      return gradient("135deg", `${a} 0 38%,${b} 38% 58%,${a} 58% 100%`);
    default:
      return a;
  }
}

/**
 * O selo do clube: um quadrado arredondado com as cores do clube, um padrão inspirado na camisa e a sigla (as três primeiras
 * letras do ticker), como nos protótipos. Nenhuma tela usa escudo ou imagem de clube (critério 34 da carteira): sem cores
 * aprovadas, sai o selo neutro. O desenho é decorativo; o nome fica no texto ao lado (ou no rótulo, sem ele).
 */
export function ClubBadgeMark({ club, size = 28 }: { club: BadgeClub; size?: number }) {
  const badge = badgeOf(club);
  const abbr = (club.badgeAbbr ?? badgeAbbrOf(club.ticker)).slice(0, 3);
  const plate = badge.ink === "#111111" ? "rgba(255,255,255,.86)" : "rgba(10,12,16,.62)";
  return (
    <span
      data-testid="selo"
      data-pattern={badge.pattern}
      role="img"
      aria-label={club.ticker ? `Selo ${club.ticker}, ${club.name}` : `Selo ${club.name}`}
      style={{
        flex: "none",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.26),
        background: badgeBackground(badge),
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,.22),0 0 0 1px rgba(0,0,0,.25)",
        overflow: "hidden",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          lineHeight: 1,
          fontFamily: "'Barlow Condensed',Inter,sans-serif",
          fontWeight: 700,
          fontSize: Math.max(9, Math.round(size * 0.34)),
          letterSpacing: ".02em",
          color: badge.ink,
          background: plate,
          padding: `${Math.round(size * 0.05)}px ${Math.round(size * 0.07)}px`,
          borderRadius: Math.round(size * 0.08),
        }}
      >
        {abbr}
      </span>
    </span>
  );
}

/** O selo com o ticker e, se pedido, o nome do clube ao lado (a forma que a carteira, o mercado e o IPO usam). */
export function ClubBadge({ club, showName = true, size = 28 }: { club: BadgeClub; showName?: boolean; size?: number }) {
  return (
    <span className="cb" data-testid="selo-clube">
      <ClubBadgeMark club={club} size={size} />
      <span style={{ minWidth: 0 }}>
        <span className="b">{club.ticker}</span>
        {showName && <span className="xs muted" style={{ display: "block" }}>{club.name}</span>}
      </span>
    </span>
  );
}
