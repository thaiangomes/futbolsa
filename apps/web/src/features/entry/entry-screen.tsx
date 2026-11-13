"use client";

import { useCallback, useEffect, useState } from "react";
import type { EnterResult, EntryModeChoice, EntryPreview } from "@futbolsa/contracts";
import { ApiError } from "../../lib/api";
import { formatCents, formatInt } from "../../lib/format";
import type { EntryApi } from "./api";

/** De quanto em quanto tempo a prévia se atualiza sozinha (ms). Ela não trava nada no servidor. */
export const PREVIEW_REFRESH_MS = 20_000;

type Quote = NonNullable<EntryPreview["quote"]>;

/** O que mudou entre a prévia mostrada e o resultado final (critério 8): `null` se nada mudou. */
export function changedFromPreview(quote: Quote | null, result: EnterResult): string | null {
  if (!quote || result.mode !== "index") return null;
  if (quote.n === result.n && quote.cash === result.cash) return null;
  return `Os preços mudaram antes da confirmação: você ficou com ${formatInt(result.n)} ações de cada clube e ${formatCents(result.cash)} em caixa (a prévia mostrava ${formatInt(quote.n)} e ${formatCents(quote.cash)}).`;
}

/** A tela de entrada no meio da temporada (prancha 5): carteira índice marcada, só caixa, prévia e confirmação. */
export function EntryScreen({ api, refreshMs = PREVIEW_REFRESH_MS }: { api: EntryApi; refreshMs?: number }) {
  const [preview, setPreview] = useState<EntryPreview | null>(null);
  const [mode, setMode] = useState<EntryModeChoice>("index");
  const [result, setResult] = useState<EnterResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setPreview(await api.preview());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Não deu para carregar a entrada. Tente de novo.");
    }
  }, [api]);

  useEffect(() => {
    void load();
    if (refreshMs <= 0) return;
    const timer = setInterval(() => void load(), refreshMs);
    return () => clearInterval(timer);
  }, [load, refreshMs]);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const done = await api.enter(mode);
      setNotice(changedFromPreview(preview?.quote ?? null, done));
      setResult(done);
    } catch (e) {
      if (e instanceof ApiError && e.code === "already_entered") await load();
      setError(e instanceof ApiError ? e.message : "Não deu para confirmar. Tente de novo.");
    } finally {
      setBusy(false);
    }
  }

  if (result) return <Done result={result} notice={notice} />;
  if (!preview) {
    return error ? (
      <p role="alert" className="muted">
        {error}
      </p>
    ) : (
      <p className="muted">Carregando…</p>
    );
  }
  if (preview.availability === "already_entered") {
    return (
      <section className="card card-b stack-s" data-state="already_entered">
        <p className="m0">{preview.message}</p>
        <a className="btn btn-p" href="/carteira">
          Ver minha carteira
        </a>
      </section>
    );
  }
  if (preview.availability !== "open" || !preview.quote) return <Blocked preview={preview} onRetry={load} />;

  const quote = preview.quote;
  return (
    <div className="stack" data-state="open">
      <p className="muted m0">
        A temporada já começou. Escolha como entrar: o jogo emite ações novas de cada clube para você, sem tirar de ninguém.
      </p>
      <fieldset className="stack-s" style={{ border: 0, padding: 0 }}>
        <legend className="b">Como você quer entrar</legend>
        <label className="card card-b row-s" data-option="index">
          <input type="radio" name="mode" value="index" checked={mode === "index"} onChange={() => setMode("index")} />
          <span className="stack-s" style={{ gap: 2 }}>
            <span className="b">Carteira índice (recomendada)</span>
            <span className="muted small">
              Um pouco de cada clube, como um fundo de índice da bolsa: {formatInt(quote.n)} ações de cada um dos {quote.clubCount} clubes (
              {formatCents(quote.stockValue)}) e {formatCents(quote.cash)} em caixa.
            </span>
          </span>
        </label>
        <label className="card card-b row-s" data-option="cash">
          <input type="radio" name="mode" value="cash" checked={mode === "cash"} onChange={() => setMode("cash")} />
          <span className="stack-s" style={{ gap: 2 }}>
            <span className="b">Só caixa</span>
            <span className="muted small">
              R$ 100.000,00 para montar a carteira comprando no mercado. As ações emitidas vão para a tesouraria.
            </span>
          </span>
        </label>
      </fieldset>
      {mode === "index" && (
        <section className="card card-b stack-s" aria-label="Cotações da prévia">
          <p className="muted small m0">Cotações agora. A confirmação vale o preço do momento e mostra o resultado final.</p>
          <table className="tbl">
            <thead>
              <tr>
                <th>Clube</th>
                <th>Cotação</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {quote.clubs.map((c) => (
                <tr key={c.ticker} data-ticker={c.ticker}>
                  <td>{c.ticker}</td>
                  <td>{formatCents(c.price)}</td>
                  <td>{formatInt(c.shares)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {quote.n === 0 && (
            <p className="muted small m0">A soma das cotações passa de R$ 70.000,00: você recebe os R$ 100.000,00 só em caixa.</p>
          )}
        </section>
      )}
      {error && (
        <p role="alert" className="err">
          {error}
        </p>
      )}
      <div className="row">
        <button type="button" className="btn btn-p btn-lg" disabled={busy} onClick={() => void confirm()}>
          Confirmar
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void load()}>
          Atualizar cotações
        </button>
      </div>
    </div>
  );
}

function Blocked({ preview, onRetry }: { preview: EntryPreview; onRetry(): Promise<void> }) {
  const retry = preview.availability === "settling" || preview.availability === "market_suspended";
  return (
    <section className="card card-b stack-s" data-state={preview.availability}>
      {preview.availability === "window_closed" && <p className="b m0">Caixa: R$ 0,00</p>}
      <p className="m0">{preview.message}</p>
      {retry && (
        <button type="button" className="btn" onClick={() => void onRetry()}>
          Tentar de novo
        </button>
      )}
    </section>
  );
}

function Done({ result, notice }: { result: EnterResult; notice: string | null }) {
  return (
    <section className="card card-b stack-s" data-state="done">
      <h2 className="h2 m0">Pronto, você entrou.</h2>
      {notice && (
        <p role="status" className="warn">
          {notice}
        </p>
      )}
      <div className="kv">
        <span>Caixa</span>
        <span>{formatCents(result.cash)}</span>
      </div>
      {result.mode === "index" && result.n > 0 && (
        <div className="kv">
          <span>Ações</span>
          <span>
            {formatInt(result.n)} de cada um dos {result.clubs.length} clubes ({formatCents(result.stockValue)})
          </span>
        </div>
      )}
      <a className="btn btn-p" href="/carteira">
        Ver minha carteira
      </a>
    </section>
  );
}
