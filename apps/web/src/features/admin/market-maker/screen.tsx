"use client";

import { useState } from "react";
import type { AdminApi } from "../api";
import { reasonFeedback } from "../forms";
import { Card, ErrorNote, LoadState, ReasonField, useAction, useLoader } from "../ui";
import { changesOf, type MarketMakerForm, formErrors, formOf, formatPercent } from "./form";

/**
 * Percentuais da quantidade que a casa cota por lado, no modo de jogo e fora dele (prancha 7l; livro de ofertas,
 * critério 34). Vale na reposição seguinte, com motivo no registro do admin. O lote do IPO é só lido: trava na
 * abertura do IPO. Falta a tabela da tesouraria da prancha: a API ainda não devolve as ações livres por clube.
 */
export function MarketMakerScreen({ admin }: { admin: AdminApi }) {
  const loader = useLoader(() => admin.marketMaker());
  const season = useLoader(() => admin.currentSeason());
  const action = useAction();
  const [edit, setEdit] = useState<MarketMakerForm | null>(null);
  const [reason, setReason] = useState("");
  const [saved, setSaved] = useState(false);
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
  const lotLocked = season.data?.season ? season.data.season.status !== "preparing" : false;
  const hint = !changes ? "Mude um dos números para salvar." : !reasonOk ? "Sem motivo, a mudança é recusada." : "Confira o depois antes de salvar.";

  const save = async () => {
    if (!changes) return;
    if (await action.run(async () => loader.set(await admin.updateMarketMaker({ ...changes, reason })))) {
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
  );
}
