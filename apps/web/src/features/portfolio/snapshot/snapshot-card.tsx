"use client";

import type { Snapshot } from "@futbolsa/contracts";
import { useEffect, useState } from "react";
import type { ApiClient } from "../../../lib/api";
import { type PortfolioApi, portfolioApi } from "../api";
import { formatMonth, formatPermille } from "../format";

/**
 * A foto mensal da carteira no perfil (prancha 6c): só as fatias em %, o mês da foto e nenhuma quantidade, preço ou valor.
 * Sem foto ainda, o texto diz isso. O caixa negativo (estorno) aparece como fatia negativa.
 */
export function SnapshotCard({ snapshot }: { snapshot: Snapshot | null }) {
  return (
    <section className="card" aria-labelledby="t-foto" data-testid="foto-carteira">
      <div className="card-h">
        <h2 className="card-t" id="t-foto">Foto mensal da carteira</h2>
        {snapshot && <span className="xs muted" data-testid="foto-mes">{formatMonth(snapshot.month)}</span>}
      </div>
      <div className="card-b stack-s">
        {snapshot === null ? (
          <p className="small muted m0" data-testid="sem-foto">Ainda não há foto: ela é tirada no fechamento de cada mês e mostra só a fatia de cada clube, sem quantidades.</p>
        ) : snapshot.slices.length === 0 ? (
          <p className="small muted m0">A carteira estava zerada no fechamento do mês.</p>
        ) : (
          snapshot.slices.map((s) => (
            <div key={s.key} className="slice-row" data-testid="fatia" data-key={s.key}>
              <div>
                <div className="small b">{s.key === "cash" ? "Caixa" : s.key} {s.name && <span className="muted">· {s.name}</span>}</div>
                <div className="slice-track" aria-hidden="true">
                  <div className="slice-fill" style={{ width: `${Math.max(0, Math.min(100, s.permille / 10))}%` }} />
                </div>
              </div>
              <div className={`num b r${s.permille < 0 ? " neg-cash" : ""}`} style={{ textAlign: "right" }}>{formatPermille(s.permille)}</div>
            </div>
          ))
        )}
        <p className="xs muted m0">O que os outros jogadores veem: só porcentagens, nunca o valor nem a quantidade de ações.</p>
      </div>
    </section>
  );
}

/** Lê o perfil público do jogador (`GET /players/:nickname`) e mostra a foto dele. Falha de rede some em silêncio. */
export function ProfileSnapshot({ nickname, api }: { nickname: string; api: ApiClient | PortfolioApi }) {
  const [state, setState] = useState<{ loaded: boolean; snapshot: Snapshot | null }>({ loaded: false, snapshot: null });
  useEffect(() => {
    let alive = true;
    const client = "player" in api ? api : portfolioApi(api);
    Promise.resolve()
      .then(() => client.player(nickname))
      .then((p) => alive && setState({ loaded: true, snapshot: p.snapshot }))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [api, nickname]);
  if (!state.loaded) return null;
  return <SnapshotCard snapshot={state.snapshot} />;
}
