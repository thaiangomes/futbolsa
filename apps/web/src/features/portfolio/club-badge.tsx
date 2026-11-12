import type { PortfolioClub } from "@futbolsa/contracts";

/**
 * O selo do clube nas telas da carteira: o ticker (e o nome), com as cores e a sigla do selo quando o banco as tem.
 * Nenhuma tela usa escudo ou imagem de clube (critério 34): sem cores, um selo neutro com a sigla. O fundo é decorativo.
 */
export function ClubBadge({ club, showName = true }: { club: Pick<PortfolioClub, "ticker" | "name" | "badgeAbbr" | "colorPrimary" | "colorSecondary">; showName?: boolean }) {
  const abbr = (club.badgeAbbr ?? club.ticker).slice(0, 3);
  const style = club.colorPrimary ? { background: club.colorPrimary, color: club.colorSecondary ?? "#FFFFFF", borderColor: club.colorPrimary } : undefined;
  return (
    <span className="cb" data-testid="selo-clube">
      <span className="badge" style={style} aria-hidden="true">{abbr}</span>
      <span style={{ minWidth: 0 }}>
        <span className="b">{club.ticker}</span>
        {showName && <span className="xs muted" style={{ display: "block" }}>{club.name}</span>}
      </span>
    </span>
  );
}
