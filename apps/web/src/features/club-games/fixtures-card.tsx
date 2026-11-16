"use client";

import type { ClubFixtures } from "@futbolsa/contracts";
import { useEffect, useState } from "react";
import { ClubBadgeMark } from "../portfolio/club-badge";
import { competitionName, formatKickoff, stageText, venueText } from "./format";

/** Só o que o cartão pede da API (o `MarketApi` inteiro também serve). */
export interface FixturesApi {
  fixtures(ticker: string): Promise<ClubFixtures>;
}

/** Quantos jogos o cartão mostra (o calendário inteiro fica fora da tela do clube). */
const SHOWN = 5;

/** Lê os próximos jogos do clube ao abrir a tela. */
export function useClubFixtures(api: FixturesApi, ticker: string): { data: ClubFixtures | null; status: "loading" | "ready" | "error" } {
  const [state, setState] = useState<{ data: ClubFixtures | null; status: "loading" | "ready" | "error" }>({ data: null, status: "loading" });
  useEffect(() => {
    let alive = true;
    setState({ data: null, status: "loading" });
    Promise.resolve()
      .then(() => api.fixtures(ticker))
      .then(
        (data) => alive && setState({ data, status: "ready" }),
        () => alive && setState({ data: null, status: "error" }),
      );
    return () => {
      alive = false;
    };
  }, [api, ticker]);
  return state;
}

/**
 * "Próximos jogos" (item 9 da fila da partida de teste): os jogos agendados do clube em todas as competições, com a data e a
 * hora de Brasília, o adversário com o selo, o mando, a competição e a rodada ou a fase. O jogo que já começou e ainda não
 * tem placar aparece como "Em jogo agora".
 */
export function NextGamesCard({ ticker, api }: { ticker: string; api: FixturesApi }) {
  const { data, status } = useClubFixtures(api, ticker);
  return (
    <section className="card" aria-labelledby="t-jogos" data-testid="proximos-jogos">
      <div className="card-h"><h2 className="card-t" id="t-jogos">Próximos jogos</h2><span className="xs muted">Horário de Brasília</span></div>
      <div className="card-b">
        {!data ? (
          <p className="muted m0">{status === "error" ? "Não foi possível carregar os jogos agora." : "Carregando…"}</p>
        ) : data.fixtures.length === 0 ? (
          <p className="muted m0" data-testid="sem-jogos">Nenhum jogo agendado.</p>
        ) : (
          <ul className="stack-s" style={{ listStyle: "none", margin: 0, padding: 0, gap: 10 }}>
            {data.fixtures.slice(0, SHOWN).map((f) => (
              <li key={`${f.kickoff}|${f.competition}`} className="row between" style={{ gap: 12, flexWrap: "nowrap", alignItems: "center" }} data-testid="jogo">
                <span className="cb">
                  <ClubBadgeMark club={{ ticker: f.opponent.ticker ?? "", name: f.opponent.name, badgeAbbr: f.opponent.ticker ? undefined : f.opponent.name.slice(0, 3).toUpperCase() }} size={30} />
                  <span style={{ minWidth: 0 }}>
                    <span className="b" data-testid="adversario">{venueText(f)} · {f.opponent.name}</span>
                    <span className="xs muted" style={{ display: "block" }}>
                      {competitionName(f.competition)}{stageText(f) ? ` · ${stageText(f)}` : ""}
                    </span>
                  </span>
                </span>
                <span className="r" style={{ flex: "none" }}>
                  {f.inPlay ? (
                    <span className="chip chip-live" data-testid="em-jogo"><span className="dot-live" />Em jogo agora</span>
                  ) : (
                    <span className="num b small" data-testid="quando">{formatKickoff(f.kickoff)}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
