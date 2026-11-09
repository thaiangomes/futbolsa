"use client";

import { adminReasonSchema, IPO_ERROR_MESSAGES, type SeasonView } from "@futbolsa/contracts";
import { useState } from "react";
import { formatInstant } from "../../../lib/format";
import { ErrorNote, useAction } from "../../ipo/ui";
import type { AdminApi } from "../api";
import { Card } from "../ui";
import { brasiliaInputToIso, tradingOpensAfter } from "./dates";

/**
 * Adiar o fechamento do IPO (prancha 7d, ajuste da 7c): só com a temporada em `ipo_open`. O admin escolhe o
 * novo fechamento (hora de Brasília) e a tela mostra a abertura da negociação que isso dá (10h do dia seguinte).
 * Antecipar é recusado pela API (`ipo_close_earlier`) e a recusa aparece com a mensagem do código.
 */
export function PostponeIpo({ season, admin, onDone }: { season: SeasonView; admin: AdminApi; onDone(): Promise<void> }) {
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [done, setDone] = useState<SeasonView | null>(null);
  const action = useAction();
  if (season.status !== "ipo_open") return null;

  const newCloseIso = brasiliaInputToIso(value);
  const earlier = newCloseIso !== null && season.ipoClosesAt !== null && Date.parse(newCloseIso) < Date.parse(season.ipoClosesAt);
  const reasonOk = reason === "" || adminReasonSchema.safeParse(reason).success;

  const submit = async () => {
    if (!newCloseIso) return;
    const ok = await action.run(async () => {
      const updated = await admin.patchSeason(season.id, { ipoClosesAt: newCloseIso, ...(reason ? { reason } : {}) });
      setDone(updated);
      setValue("");
      setReason("");
    });
    if (ok) await onDone();
  };

  return (
    <div data-testid="adiar-ipo">
      <Card title="Adiar o fechamento do IPO">
        <form className="stack-s" onSubmit={(e) => { e.preventDefault(); if (newCloseIso && reasonOk && !action.busy) void submit(); }}>
          <div className="g-3 small">
            <div className="kv"><span>Fechamento de agora</span><span>{formatInstant(season.ipoClosesAt)}</span></div>
            <div className="kv"><span>Negociação abre (de agora)</span><span>{formatInstant(season.tradingOpensAt)}</span></div>
          </div>
          <div className="row">
            <div className="field">
              <label htmlFor="novo-fechamento">Novo fechamento (horário de Brasília)</label>
              <input id="novo-fechamento" className="input" type="datetime-local" value={value} onChange={(e) => { setValue(e.target.value); action.clearError(); }} />
            </div>
            <div className="field">
              <label htmlFor="motivo-adiar">Motivo (opcional)</label>
              <input id="motivo-adiar" className={`input${reasonOk ? "" : " err"}`} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
              {!reasonOk && <span className="hint err">Use de 3 a 500 caracteres.</span>}
            </div>
          </div>
          {newCloseIso && !earlier && (
            <div className="kv" data-testid="nova-abertura">
              <span>Nova abertura da negociação</span>
              <span>{formatInstant(tradingOpensAfter(newCloseIso))}</span>
            </div>
          )}
          {earlier && <span className="hint err">{IPO_ERROR_MESSAGES.ipo_close_earlier}</span>}
          <ErrorNote message={action.error} />
          {done && (
            <div className="note note-ok" role="status" data-testid="adiado">
              <div>
                Fechamento adiado para <b className="num">{formatInstant(done.ipoClosesAt)}</b>. A negociação abre em{" "}
                <b className="num">{formatInstant(done.tradingOpensAt)}</b>. A abertura das ofertas e os valores travados não mudam.
              </div>
            </div>
          )}
          <button type="submit" className="btn btn-p btn-sm" disabled={!newCloseIso || !reasonOk || action.busy}>Adiar o fechamento</button>
          <p className="xs muted" style={{ margin: 0 }}>Só dá para adiar: antecipar o fechamento é recusado. O adiamento fica no registro do admin.</p>
        </form>
      </Card>
    </div>
  );
}
