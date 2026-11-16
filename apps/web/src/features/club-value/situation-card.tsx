import type { ClubValueCup, ClubValueView } from "@futbolsa/contracts";
import { CUP_NAMES, cupStateText } from "./model";

/** O que o clube é numa copa, em palavras: `Campeão`, `Eliminado` ou onde está (`nas oitavas`). */
export function cupSituationText(cup: ClubValueCup): string {
  if (cup.outcome === "champion") return "Campeão";
  if (cup.outcome === "eliminated") return "Eliminado";
  return `Disputando: ${cupStateText(cup).replace(/^está /, "")}`;
}

/**
 * "Situação nas competições" (item 10 da fila da partida de teste): a colocação, os pontos e os jogos do clube no Brasileirão
 * (Série A ou B) e em que fase ele está em cada copa que disputa (disputando, eliminado ou campeão). Usa os mesmos dados da
 * rota do simulador; nada da casa.
 */
export function SituationCard({ view }: { view: ClubValueView }) {
  const leagueName = view.league === "brasileirao-a" ? "Brasileirão · Série A" : "Série B";
  return (
    <section className="card" aria-labelledby="t-situacao" data-testid="situacao">
      <div className="card-h"><h2 className="card-t" id="t-situacao">Situação nas competições</h2></div>
      <div className="card-b stack-s" style={{ gap: 6 }}>
        <div className="kv" data-testid="situacao-liga">
          <span>{leagueName}</span>
          <span>
            {view.played === 0 && view.position === null
              ? "ainda sem jogos"
              : `${view.position ? `${view.position}º lugar · ` : ""}${view.points} ${view.points === 1 ? "ponto" : "pontos"} · ${view.played} ${view.played === 1 ? "jogo" : "jogos"}`}
          </span>
        </div>
        {view.cups.map((cup) => (
          <div key={cup.competition} className="kv" data-testid="situacao-copa" data-competition={cup.competition}>
            <span>{CUP_NAMES[cup.competition] ?? cup.competition}</span>
            <span>{cupSituationText(cup)}</span>
          </div>
        ))}
        {view.cups.length === 0 && <span className="xs muted">O clube não disputa copas nesta temporada.</span>}
      </div>
    </section>
  );
}
