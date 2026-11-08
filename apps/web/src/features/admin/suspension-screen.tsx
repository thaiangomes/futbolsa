"use client";

import { useState } from "react";
import { useChannel } from "../../realtime/react";
import type { AdminApi } from "./api";
import { reasonFeedback } from "./forms";
import { Card, ErrorNote, LoadState, ReasonField, useAction, useLoader } from "./ui";

/**
 * Suspender e retomar a negociação de um clube ou do mercado todo, com motivo que todos os jogadores veem
 * (Admin, critérios 23 e 24). As ordens abertas ficam no livro; só as cotações da casa saem.
 */
export function SuspensionScreen({ admin }: { admin: AdminApi }) {
  const loader = useLoader(() => admin.suspensions());
  useChannel("season", { onEvent: (e) => (e.type === "market.suspended" || e.type === "market.resumed") && void loader.reload() });
  const action = useAction();
  const [scope, setScope] = useState<"club" | "market">("club");
  const [ticker, setTicker] = useState("");
  const [reason, setReason] = useState("");
  const state = loader.data;
  if (!state) return <LoadState loader={loader} />;

  const tickerOk = scope === "market" || /^[A-Z]{3,5}\d{1,2}$/.test(ticker);
  const canSuspend = reasonFeedback(reason).ok && tickerOk && !action.busy;
  const suspend = async () => {
    if (await action.run(() => admin.suspend(reason, scope === "club" ? ticker : undefined))) {
      setReason("");
      setTicker("");
      await loader.reload();
    }
  };
  const resume = async (clubTicker?: string) => {
    if (await action.run(() => admin.resume(clubTicker))) await loader.reload();
  };

  return (
    <div className="stack">
      <Card title="Situação agora">
        {state.market === null && state.clubs.length === 0 ? (
          <p className="m0">A negociação está aberta em todos os clubes.</p>
        ) : (
          <ul className="stack-s" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {state.market && (
              <li className="row between">
                <span><span className="chip chip-down">Mercado todo</span> {state.market.reason}</span>
                <button type="button" className="btn btn-sm" disabled={action.busy} onClick={() => void resume()}>Retomar o mercado</button>
              </li>
            )}
            {state.clubs.map((c) => (
              <li key={c.ticker} className="row between">
                <span><span className="chip chip-down">{c.ticker}</span> {c.reason}</span>
                <button type="button" className="btn btn-sm" disabled={action.busy} onClick={() => void resume(c.ticker)}>Retomar {c.ticker}</button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Suspender a negociação">
        <form className="stack-s" onSubmit={(e) => { e.preventDefault(); void suspend(); }}>
          <div className="seg" role="group" aria-label="O que suspender">
            <button type="button" aria-pressed={scope === "club"} onClick={() => setScope("club")}>Um clube</button>
            <button type="button" aria-pressed={scope === "market"} onClick={() => setScope("market")}>O mercado todo</button>
          </div>
          {scope === "club" && (
            <div className="field">
              <label htmlFor="ticker">Ticker do clube</label>
              <input id="ticker" className="input" value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} placeholder="FLA3" maxLength={6} />
            </div>
          )}
          <ReasonField value={reason} onChange={setReason} label="Motivo (todos os jogadores veem)" />
          <div className="note"><div>As ordens abertas dos jogadores ficam no livro e podem ser canceladas. Só as cotações da casa saem. A suspensão não muda quem recebe dividendo.</div></div>
          <ErrorNote message={action.error} />
          <button type="submit" className="btn btn-p" disabled={!canSuspend}>Suspender</button>
        </form>
      </Card>
    </div>
  );
}
