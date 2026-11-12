"use client";

import { useState } from "react";
import type { ApplyCorrectionResponse, CorrectionPreview } from "@futbolsa/contracts";
import type { AdminApi } from "../../api";
import { formatCents, formatInstant, reasonFeedback } from "../../forms";
import { Card, ErrorNote, LoadState, ReasonField, useAction, useLoader } from "../../ui";
import { groupLabel, KIND_LABELS, newChangeKeys, stalePreview } from "../model";

const OUTCOME_NOTES = { correction: "", new_in_paid_group: "evento novo numa rodada já paga", vanished: "sumiu (vira R$ 0,00)" } as const;

/** Diferença por ação com sinal: positivo é complemento, negativo é estorno. */
const signed = (cents: number) => `${cents > 0 ? "+" : cents < 0 ? "−" : ""}${formatCents(Math.abs(cents))}`;

/**
 * Correção de resultado depois de pago (prancha 7b; Admin, critérios 12, 13, 17 e 33). A prévia é só de leitura: a
 * diferença por evento e clube, o resumo por carteira (quantas recebem, quantas devolvem, quantas ficam com o caixa
 * negativo e quantas compras abertas serão canceladas) e os meses de ranking afetados. Aplicar exige o motivo e vale
 * só para a prévia que o admin viu (o código do plano): se outro resultado mudou no meio, a API recusa com
 * `correction_stale` e manda a prévia nova, que a tela mostra com as linhas novas marcadas, para conferir outra vez.
 */
export function CorrectionScreen({ admin }: { admin: AdminApi }) {
  const loader = useLoader(() => admin.correctionPreview());
  const action = useAction();
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [stale, setStale] = useState<{ preview: CorrectionPreview; fresh: Set<string> } | null>(null);
  const [staleNoPreview, setStaleNoPreview] = useState(false);
  const [done, setDone] = useState<ApplyCorrectionResponse | null>(null);

  const original = loader.data;
  if (!original) return <LoadState loader={loader} />;
  const preview = stale?.preview ?? original;
  const fresh = stale?.fresh ?? new Set<string>();
  const reasonOk = reasonFeedback(reason).ok;
  const noChanges = preview.changes.length === 0;

  const apply = async () => {
    setConfirming(false);
    action.clearError();
    const seen: { stale: ReturnType<typeof stalePreview> } = { stale: null };
    const ok = await action.run(async () => {
      try {
        setDone(await admin.applyCorrection({ planCode: preview.planCode, reason }));
      } catch (error) {
        seen.stale = stalePreview(error);
        throw error;
      }
    });
    if (ok) {
      setStale(null);
      setReason("");
      return;
    }
    if (seen.stale) {
      const next = seen.stale.preview;
      if (next) {
        setStale({ preview: next, fresh: newChangeKeys(preview, next) });
        setStaleNoPreview(false);
      } else {
        setStaleNoPreview(true);
        await loader.reload();
      }
    }
  };

  if (done) {
    return (
      <div className="stack">
        <div className="note note-ok" role="status">
          <div>
            <strong>Correção aplicada.</strong> {done.events.length} {done.events.length === 1 ? "evento ganhou" : "eventos ganharam"} versão nova, já aprovada. Os estornos e complementos saem em lotes, em segundo plano: acompanhe em <a href="/admin/pagamentos">Pagamentos</a>, onde cada evento aparece como "Liquidando" até acabar.
          </div>
        </div>
        <button type="button" className="btn" onClick={() => { setDone(null); void loader.reload(); }}>Ver a prévia de agora</button>
      </div>
    );
  }

  const w = preview.wallets;
  return (
    <div className="stack">
      {stale && (
        <div className="note note-err" role="alert">
          <div>
            <strong>Prévia desatualizada.</strong> Um resultado mudou desde que você abriu esta tela, e nada foi aplicado. A prévia abaixo é a nova
            {fresh.size > 0 ? `; ${fresh.size === 1 ? "a linha marcada é a que mudou" : "as linhas marcadas são as que mudaram"}` : ""}. Confira e aplique de novo.
          </div>
        </div>
      )}
      {staleNoPreview && (
        <div className="note note-err" role="alert"><div><strong>Prévia desatualizada.</strong> Os resultados mudaram e a prévia foi recarregada: confira antes de aplicar.</div></div>
      )}
      <div className="g-4" style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
        <Stat label="Carteiras que recebem" value={w.receive} />
        <Stat label="Carteiras que devolvem" value={w.pay} />
        <Stat label="Ficam com caixa negativo" value={w.negative} warn={w.negative > 0} />
        <Stat label="Compras abertas canceladas" value={w.buysCancelled} warn={w.buysCancelled > 0} />
      </div>
      {w.negative > 0 && (
        <div className="note note-err" role="note">
          <div>Quem não tem caixa para devolver fica com o caixa negativo, e as compras abertas dessa carteira são canceladas antes para liberar o que der. Ele não consegue comprar de novo até o caixa voltar a zero.</div>
        </div>
      )}
      <Card title="O que muda por evento e clube" right={<span className="xs muted">Meses de ranking afetados: {preview.months.length ? preview.months.join(", ") : "nenhum"}</span>}>
        {noChanges ? (
          <p className="muted m0">Nada a corrigir: os pagamentos já estão de acordo com os resultados de agora.</p>
        ) : (
          <div className="scroll-x">
            <table className="tbl">
              <thead>
                <tr><th>Clube</th><th>Evento</th><th className="r">Antes</th><th className="r">Depois</th><th className="r">Diferença por ação</th><th className="r">Ações</th><th className="r">Move</th><th>Fechamento</th></tr>
              </thead>
              <tbody>
                {preview.changes.map((c) => (
                  <tr key={c.key} data-fresh={fresh.has(c.key) ? "sim" : undefined} style={fresh.has(c.key) ? { background: "var(--panel2)" } : undefined}>
                    <td className="b">{c.club.ticker ?? c.club.name}</td>
                    <td className="small">
                      {KIND_LABELS[c.kind]} · {groupLabel(c)} · {c.reason}
                      {OUTCOME_NOTES[c.outcome] && <div className="xs muted">{OUTCOME_NOTES[c.outcome]}</div>}
                      {fresh.has(c.key) && <span className="chip chip-live">novo</span>}
                    </td>
                    <td className="r">{formatCents(c.before)}</td>
                    <td className="r">{formatCents(c.after)}</td>
                    <td className="r b">{signed(c.delta)}</td>
                    <td className="r">{c.shares.toLocaleString("pt-BR")}</td>
                    <td className="r">{signed(c.total)}</td>
                    <td className="small">{c.closedAtBefore !== c.closedAtAfter ? `${formatInstant(c.closedAtBefore)} → ${formatInstant(c.closedAtAfter)}` : formatInstant(c.closedAtAfter)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {!noChanges && (
        <Card title="Aplicar a correção">
          <form className="stack" onSubmit={(e) => { e.preventDefault(); if (reasonOk && !action.busy) setConfirming(true); }}>
            <ReasonField value={reason} onChange={setReason} label="Motivo (obrigatório; fica no registro com o resumo da prévia)" />
            <ErrorNote message={action.error} />
            <div className="row between">
              <span className="xs muted">Aplica exatamente esta prévia. Se um resultado mudar antes, nada é aplicado e você vê a prévia nova.</span>
              {confirming ? (
                <span className="row-s" role="group" aria-label="Confirmar correção">
                  <span className="small">Aplicar e mexer no caixa de {w.receive + w.pay} carteiras?</span>
                  <button type="button" className="btn btn-p" disabled={action.busy} onClick={() => void apply()}>Confirmar</button>
                  <button type="button" className="btn" onClick={() => setConfirming(false)}>Voltar</button>
                </span>
              ) : (
                <button type="submit" className="btn btn-p" disabled={!reasonOk || action.busy}>Aplicar correção</button>
              )}
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="card">
      <div className="card-b stack-s" style={{ gap: 4 }}>
        <span className="xs muted">{label}</span>
        <span className="disp num" style={{ fontSize: 28, fontWeight: 700, color: warn ? "var(--down, #c0392b)" : undefined }}>{value.toLocaleString("pt-BR")}</span>
      </div>
    </div>
  );
}
