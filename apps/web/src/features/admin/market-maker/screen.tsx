"use client";

import { useState } from "react";
import type { AdminApi } from "../api";
import { formatCents, formatInstant, reasonFeedback } from "../forms";
import { Card, ErrorNote, LoadState, ReasonField, useAction, useLoader } from "../ui";
import { changesOf, describeSide, type MarketMakerForm, formErrors, formOf, formatPercent, parseMinimum, parsePercent, quoteNote } from "./form";

/**
 * Percentuais da quantidade que a casa cota por lado, no modo de jogo e fora dele (prancha 7l; livro de ofertas,
 * critério 34). Vale na reposição seguinte, com motivo no registro do admin. O lote do IPO é só lido: trava na
 * abertura do IPO. Embaixo, a tesouraria agora: ações livres, situação e o que a casa consegue cotar em cada clube.
 */
export function MarketMakerScreen({ admin }: { admin: AdminApi }) {
  const loader = useLoader(() => admin.marketMaker());
  const season = useLoader(() => admin.currentSeason());
  const action = useAction();
  const [edit, setEdit] = useState<MarketMakerForm | null>(null);
  const [reason, setReason] = useState("");
  const [saved, setSaved] = useState(false);
  const [previewTicker, setPreviewTicker] = useState<string | null>(null);
  const state = loader.data;
  if (!state) return <LoadState loader={loader} />;

  const form = edit ?? formOf(state);
  const set = (key: keyof MarketMakerForm) => (value: string) => {
    setEdit({ ...form, [key]: value });
    setSaved(false);
  };
  const { invalid, message } = formErrors(form);
  const changes = changesOf(state, form);
  const reasonOk = reasonFeedback(reason).ok;
  const canSave = !!changes && reasonOk && !action.busy;
  const treasury = state.treasury;
  const preview = treasury ? (treasury.clubs.find((c) => c.ticker === previewTicker) ?? treasury.clubs[0] ?? null) : null;
  const next = {
    quantityBp: parsePercent(form.quantity),
    matchQuantityBp: parsePercent(form.matchQuantity),
    minSide: parseMinimum(form.minSide),
    matchMinSide: parseMinimum(form.matchMinSide),
  };
  const after = Object.values(next).every((v) => v !== null) ? (next as { [K in keyof typeof next]: number }) : null;
  const lotLocked = season.data?.season ? season.data.season.status !== "preparing" : false;
  const hint = !changes ? "Mude um dos números para salvar." : !reasonOk ? "Sem motivo, a mudança é recusada." : "Confira o depois antes de salvar.";

  const save = async () => {
    if (!changes) return;
    if (await action.run(async () => { await admin.updateMarketMaker({ ...changes, reason }); await loader.reload(); })) {
      setEdit(null);
      setReason("");
      setSaved(true);
    }
  };
  const field = (key: keyof MarketMakerForm, id: string, label: string, now: string, percent: boolean) => (
    <div className="field">
      <label htmlFor={id} className="sr-only" style={{ position: "absolute", left: -9999 }}>{label}</label>
      <div className="row-s" style={{ flexWrap: "nowrap" }}>
        <input id={id} className={`input${invalid.has(key) ? " err" : ""}`} inputMode={percent ? "decimal" : "numeric"} value={form[key]} onChange={(e) => set(key)(e.target.value)} />
        {percent && <span className="muted">%</span>}
      </div>
      <span className="xs muted">agora {now}</span>
    </div>
  );

  return (
    <div className="stack">
    <div className="g-main-aside">
      <Card title="Quantas ações a casa cota por lado" right={<span className="xs muted">Vale na reposição seguinte, para todos os clubes</span>}>
        <form className="stack" onSubmit={(e) => { e.preventDefault(); if (canSave) void save(); }}>
          <div className="pgrid">
            <span className="hd" />
            <span className="hd">Fora de jogo</span>
            <span className="hd">No modo de jogo</span>
            <span className="small b">Percentual das ações do clube</span>
            {field("quantity", "pf", "Percentual fora de jogo", `${formatPercent(state.mmQuantityBp)}%`, true)}
            {field("matchQuantity", "pj", "Percentual no modo de jogo", `${formatPercent(state.mmMatchQuantityBp)}%`, true)}
            <span className="small b">Mínimo de ações por lado</span>
            {field("minSide", "mf", "Mínimo fora de jogo", String(state.mmMinSideQty), false)}
            {field("matchMinSide", "mj", "Mínimo no modo de jogo", String(state.mmMatchMinSideQty), false)}
          </div>
          {preview && (
            <div className="card" style={{ background: "var(--panel2)" }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>
                      Num clube de{" "}
                      <select id="previa-clube" aria-label="Clube da prévia" value={preview.ticker} onChange={(e) => setPreviewTicker(e.target.value)}>
                        {treasury!.clubs.map((c) => <option key={c.ticker} value={c.ticker}>{c.ticker}</option>)}
                      </select>{" "}
                      com {preview.totalShares.toLocaleString("pt-BR")} ações
                    </th>
                    <th className="r">Agora</th>
                    <th className="r">Depois</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Fora de jogo</td>
                    <td className="r">{describeSide(preview.totalShares, state.mmQuantityBp, state.mmMinSideQty)}</td>
                    <td className="r b" id="depois-fora">{after ? describeSide(preview.totalShares, after.quantityBp, after.minSide) : "—"}</td>
                  </tr>
                  <tr>
                    <td>No modo de jogo</td>
                    <td className="r">{describeSide(preview.totalShares, state.mmMatchQuantityBp, state.mmMatchMinSideQty)}</td>
                    <td className="r b" id="depois-jogo">{after ? describeSide(preview.totalShares, after.matchQuantityBp, after.matchMinSide) : "—"}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
          {message && <div className="note note-err" role="alert"><div>{message}</div></div>}
          <ReasonField value={reason} onChange={(v) => { setReason(v); setSaved(false); }} label="Motivo (obrigatório; fica no registro com o antes e o depois)" />
          <ErrorNote message={action.error} />
          <div className="row between">
            <span className="xs muted">{hint}</span>
            <div className="row" style={{ gap: 8 }}>
              <button type="button" className="btn" disabled={edit === null} onClick={() => { setEdit(null); setSaved(false); }}>Desfazer</button>
              <button type="submit" className="btn btn-p" disabled={!canSave}>Salvar</button>
            </div>
          </div>
          {saved && (
            <div className="note note-ok" role="status">
              <div>
                <strong>Salvo.</strong> A casa passa a cotar {formatPercent(state.mmQuantityBp)}% das ações do clube fora de jogo (mínimo {state.mmMinSideQty}) e {formatPercent(state.mmMatchQuantityBp)}% no modo de jogo (mínimo {state.mmMatchMinSideQty}) a partir da reposição seguinte, ou antes, se um evento de algum clube refizer a cotação dele.
              </div>
            </div>
          )}
        </form>
      </Card>

      <aside className="stack">
        <Card title="Lote do formador no IPO" right={lotLocked ? <span className="chip">travado</span> : undefined}>
          <div className="stack-s" style={{ gap: 6 }}>
            <span className="disp num" style={{ fontSize: 30, fontWeight: 700 }}>{formatPercent(state.mmLotBp)}% da oferta</span>
            <span className="small muted">Emitido para a tesouraria no fechamento do IPO. Só muda antes de abrir as ofertas da temporada seguinte.</span>
          </div>
        </Card>
        <Card title="O que esta tela não muda">
          <ul className="small muted stack-s m0" style={{ paddingLeft: 34, gap: 6 }}>
            <li>A faixa da casa e o valor justo: são regra do jogo, iguais para todos, e nenhum jogador os vê.</li>
            <li>De onde vêm as ações e o caixa: só da tesouraria. Sem ações livres do clube, a casa só compra; sem caixa, só vende.</li>
            <li>O túnel e o leilão: a casa cota normalmente num clube em leilão, e a oferta dela entra no preço único.</li>
          </ul>
        </Card>
      </aside>
    </div>
    {treasury && (
      <Card title="Tesouraria agora" right={<span className="xs muted">Caixa da tesouraria: {formatCents(treasury.cash)} · o que a casa consegue cotar em cada clube</span>}>
        <div className="scroll-x">
          <table className="tbl">
            <thead>
              <tr><th>Clube</th><th className="r">Ações livres na tesouraria</th><th>Situação</th><th>A casa cota</th></tr>
            </thead>
            <tbody>
              {treasury.clubs.map((c) => (
                <tr key={c.ticker}>
                  <td className="b">{c.ticker}</td>
                  <td className="r">{c.freeShares.toLocaleString("pt-BR")}</td>
                  <td><span className={STATUS_CHIP[c.status]}>{statusLabel(c)}</span></td>
                  <td className="small">{quoteNote(c, treasury.freeCash)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    )}
    </div>
  );
}

const STATUS_CHIP = { trading: "chip chip-up", in_match: "chip chip-live", auction: "chip chip-live", suspended: "chip chip-down" } as const;

function statusLabel(c: { status: keyof typeof STATUS_CHIP; auctionUntil: string | null }): string {
  if (c.status === "trading") return "Negociando";
  if (c.status === "in_match") return "Em jogo agora";
  if (c.status === "suspended") return "Suspenso";
  return c.auctionUntil ? `Em leilão até ${formatInstant(c.auctionUntil)}` : "Em leilão (parado)";
}
