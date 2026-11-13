"use client";

import { useRef, useState } from "react";
import type { PlayerDetail } from "@futbolsa/contracts";
import { formatCents, formatInstant } from "../../lib/format";
import type { AdminApi } from "./api";
import { reasonFeedback } from "./forms";
import { deleteConfirmed, previewAdjust } from "./players-logic";
import { Card, ErrorNote, LoadState, ReasonField, useAction, useLoader } from "./ui";

const STATUS_LABEL = { active: "Ativo", blocked: "Bloqueado", deleted: "Excluído" } as const;

/** Lista de jogadores com busca por começo do apelido ou e-mail exato (Admin, "Jogadores"; protótipo 7i). */
export function PlayersScreen({ admin }: { admin: AdminApi }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"" | "active" | "blocked" | "deleted">("");
  const [applied, setApplied] = useState<{ q: string; status: string }>({ q: "", status: "" });
  const [extra, setExtra] = useState<Awaited<ReturnType<AdminApi["players"]>>["items"]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const loader = useLoader(async () => {
    const first = await admin.players();
    setCursor(first.nextCursor);
    return first;
  });
  const more = useAction();
  const searching = useAction();
  const search = () =>
    searching.run(async () => {
      const next = await admin.players({ ...(q.trim() ? { q: q.trim() } : {}), ...(status ? { status } : {}) });
      setApplied({ q: q.trim(), status });
      setExtra([]);
      setCursor(next.nextCursor);
      loader.set(next);
    });
  const page = loader.data;
  if (!page) return <LoadState loader={loader} />;
  const items = [...page.items, ...extra];

  return (
    <div className="stack">
      <Card title="Buscar jogador">
        <form className="row" style={{ gap: 8, flexWrap: "wrap" }} onSubmit={(e) => { e.preventDefault(); void search(); }}>
          <div className="field" style={{ flex: 1, minWidth: 220 }}>
            <label htmlFor="busca">Começo do apelido ou e-mail exato</label>
            <input id="busca" className="input" value={q} onChange={(e) => setQ(e.target.value)} maxLength={120} />
          </div>
          <div className="field">
            <label htmlFor="situacao">Situação</label>
            <select id="situacao" className="input" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
              <option value="">Todas</option>
              <option value="active">Ativos</option>
              <option value="blocked">Bloqueados</option>
              <option value="deleted">Excluídos</option>
            </select>
          </div>
          <button type="submit" className="btn btn-p" style={{ alignSelf: "flex-end" }}>Buscar</button>
        </form>
      </Card>
      <Card title={`Jogadores (${items.length}${cursor ? "+" : ""})`}>
        <ErrorNote message={loader.error ?? searching.error} />
        {items.length === 0 ? (
          <p className="m0 muted">Ninguém encontrado.</p>
        ) : (
          <table className="tbl">
            <thead>
              <tr><th>Apelido</th><th>Situação</th><th>Papel</th><th className="r">Patrimônio</th><th>Cadastro</th></tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.id}>
                  <td>{p.status === "deleted" ? <span className="muted">conta excluída</span> : <a href={`/admin/jogador?id=${p.id}`}>{p.nickname}</a>}</td>
                  <td><span className={`chip ${p.status === "active" ? "chip-up" : "chip-down"}`}>{STATUS_LABEL[p.status]}</span></td>
                  <td>{p.role === "admin" ? "Admin" : "Jogador"}</td>
                  <td className="r">{p.equity === null ? "—" : formatCents(p.equity)}</td>
                  <td>{formatInstant(p.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <ErrorNote message={more.error} />
        {cursor && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={more.busy}
            onClick={() =>
              void more.run(async () => {
                const next = await admin.players({ ...(applied.q ? { q: applied.q } : {}), ...(applied.status ? { status: applied.status as "active" } : {}), cursor });
                setExtra((e) => [...e, ...next.items]);
                setCursor(next.nextCursor);
              })
            }
          >
            Mostrar mais
          </button>
        )}
      </Card>
    </div>
  );
}

/** O jogador: conta, carteira, ordens, ofertas e extrato, com bloquear, excluir e ajustar saldo (protótipo 7i). */
export function PlayerDetailScreen({ admin, id }: { admin: AdminApi; id: string }) {
  const loader = useLoader(() => admin.player(id));
  const entries = useLoader(() => admin.playerEntries(id, { limit: 20 }).catch(() => ({ items: [], nextCursor: null })));
  const detail = loader.data;
  if (!detail) return <LoadState loader={loader} />;
  const reload = async () => {
    await loader.reload();
    await entries.reload();
  };
  const { account, wallet } = detail;

  return (
    <div className="stack">
      <Card title={account.nickname ?? "Conta excluída"} right={<span className={`chip ${account.status === "active" ? "chip-up" : "chip-down"}`}>{STATUS_LABEL[account.status]}</span>}>
        {account.status === "deleted" ? (
          <p className="m0">Conta excluída em {formatInstant(account.deletedAt)}. Não há mais dados dela.</p>
        ) : (
          <dl className="stack-s m0">
            <div><dt className="muted small">E-mail</dt><dd className="m0">{account.email}</dd></div>
            <div><dt className="muted small">Papel</dt><dd className="m0">{account.role === "admin" ? "Admin" : "Jogador"}</dd></div>
            <div><dt className="muted small">Cadastro</dt><dd className="m0">{formatInstant(account.createdAt)}</dd></div>
            {account.blockedReason && <div><dt className="muted small">Motivo do bloqueio</dt><dd className="m0">{account.blockedReason}</dd></div>}
          </dl>
        )}
      </Card>

      {wallet && (
        <Card title="Carteira">
          <p className="m0">
            Caixa {formatCents(wallet.cash.total)} · reservado {formatCents(wallet.cash.reserved)} · <b>livre {formatCents(wallet.cash.free)}</b> · patrimônio{" "}
            {formatCents(wallet.equity)}
            {detail.entryMode && <> · entrada: {detail.entryMode === "ipo" ? "IPO" : detail.entryMode === "index" ? "carteira índice" : "só caixa"}</>}
          </p>
          {wallet.positions.length === 0 ? (
            <p className="muted">Nenhuma ação.</p>
          ) : (
            <table className="tbl">
              <thead><tr><th>Clube</th><th className="r">Ações</th><th className="r">Em ordens</th><th className="r">Custo</th><th className="r">Preço médio</th><th className="r">Preço</th></tr></thead>
              <tbody>
                {wallet.positions.map((p) => (
                  <tr key={p.club.ticker}>
                    <td>{p.club.ticker}</td><td className="r">{p.shares}</td><td className="r">{p.inOrders}</td>
                    <td className="r">{formatCents(p.cost)}</td><td className="r">{p.averagePrice === null ? "—" : formatCents(p.averagePrice)}</td><td className="r">{formatCents(p.price)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {detail.warnings.length > 0 && (
        <Card title="Advertências por trapaça nesta temporada">
          <ul className="stack-s m0" style={{ listStyle: "none", padding: 0 }}>
            {detail.warnings.map((w) => (
              <li key={w.caseId}>
                <a href={`/admin/trapaca?id=${w.caseId}`}>Caso #{w.caseId}</a> · {formatInstant(w.at)}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {(detail.openOrders.length > 0 || detail.bids.length > 0) && (
        <Card title="Ordens abertas e ofertas do IPO">
          <ul className="stack-s m0" style={{ listStyle: "none", padding: 0 }}>
            {detail.openOrders.map((o) => (
              <li key={o.id}>{o.side === "buy" ? "Compra" : "Venda"} {o.quantity - o.filled} {o.ticker}{o.limitPrice ? ` a ${formatCents(o.limitPrice)}` : " a mercado"}</li>
            ))}
            {detail.bids.map((b) => (
              <li key={b.ticker}>Oferta no IPO: {b.quantity} {b.ticker} até {formatCents(b.maxPrice)} ({b.status === "active" ? "ativa" : b.status === "settled" ? "liquidada" : "cancelada"})</li>
            ))}
          </ul>
        </Card>
      )}

      {wallet && (
        <Card title="Extrato">
          {entries.data && entries.data.items.length > 0 ? (
            <table className="tbl">
              <thead><tr><th>Quando</th><th>Tipo</th><th>Clube</th><th className="r">Ações</th><th className="r">Valor</th><th>Motivo</th></tr></thead>
              <tbody>
                {entries.data.items.map((e) => (
                  <tr key={e.id}>
                    <td>{formatInstant(e.at)}</td><td>{e.kind}</td><td>{e.club?.ticker ?? "—"}</td>
                    <td className="r">{e.quantity === 0 ? "—" : e.quantity}</td><td className="r">{e.amount === 0 ? "—" : formatCents(e.amount)}</td><td>{e.reason ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="m0 muted">Sem movimentos.</p>
          )}
        </Card>
      )}

      {account.status !== "deleted" && wallet && <AdjustCard admin={admin} id={id} detail={detail} onDone={reload} />}
      {account.status !== "deleted" && <BlockCard admin={admin} id={id} blocked={account.status === "blocked"} onDone={reload} />}
      {account.status !== "deleted" && <DeleteCard admin={admin} id={id} nickname={account.nickname} onDone={reload} />}
    </div>
  );
}

function BlockCard({ admin, id, blocked, onDone }: { admin: AdminApi; id: string; blocked: boolean; onDone(): Promise<void> }) {
  const action = useAction();
  const [reason, setReason] = useState("");
  const go = async () => {
    if (await action.run(() => (blocked ? admin.unblockPlayer(id, reason) : admin.blockPlayer(id, reason)))) {
      setReason("");
      await onDone();
    }
  };
  return (
    <Card title={blocked ? "Desbloquear" : "Bloquear"}>
      <form className="stack-s" onSubmit={(e) => { e.preventDefault(); void go(); }}>
        <ReasonField value={reason} onChange={setReason} id="motivo-bloqueio" />
        <div className="note"><div>
          {blocked
            ? "O jogador volta a negociar e a aparecer nos rankings. As ordens canceladas no bloqueio não voltam."
            : "As ordens abertas e as ofertas do IPO são canceladas. O bloqueado não negocia nem oferta e sai dos rankings; continua dono das ações e recebe dividendos."}
        </div></div>
        <ErrorNote message={action.error} />
        <button type="submit" className="btn btn-p" disabled={!reasonFeedback(reason).ok || action.busy}>{blocked ? "Desbloquear" : "Bloquear"}</button>
      </form>
    </Card>
  );
}

function DeleteCard({ admin, id, nickname, onDone }: { admin: AdminApi; id: string; nickname: string | null; onDone(): Promise<void> }) {
  const action = useAction();
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("pedido do titular");
  const go = async () => {
    if (await action.run(() => admin.deletePlayer(id, typed, reason))) await onDone();
  };
  return (
    <Card title="Excluir a conta">
      <form className="stack-s" onSubmit={(e) => { e.preventDefault(); void go(); }}>
        <div className="note note-err"><div>Não tem volta: o e-mail e o apelido somem, as ações vão para a tesouraria e o caixa é zerado.</div></div>
        <div className="field">
          <label htmlFor="confirma">Digite o apelido ({nickname}) para confirmar</label>
          <input id="confirma" className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        </div>
        <ReasonField value={reason} onChange={setReason} id="motivo-exclusao" />
        <ErrorNote message={action.error} />
        <button type="submit" className="btn btn-d" disabled={!deleteConfirmed(nickname, typed, reason) || action.busy}>Excluir a conta</button>
      </form>
    </Card>
  );
}

function AdjustCard({ admin, id, detail, onDone }: { admin: AdminApi; id: string; detail: PlayerDetail; onDone(): Promise<void> }) {
  const action = useAction();
  const [asset, setAsset] = useState<"cash" | "shares">("cash");
  const [ticker, setTicker] = useState("");
  const [amount, setAmount] = useState("");
  const [sign, setSign] = useState<1 | -1>(1);
  const [reason, setReason] = useState("");
  // a mesma chave até o envio dar certo: o clique duplo não credita duas vezes
  const key = useRef<string>(crypto.randomUUID());
  const parsed = amount.trim() === "" ? 0 : asset === "cash" ? Math.round(Number(amount.replace(",", ".")) * 100) : Number(amount);
  const delta = Number.isFinite(parsed) ? sign * parsed : 0;
  const tickerOk = asset === "cash" || /^[A-Z]{3,5}\d{1,2}$/.test(ticker);
  const preview = previewAdjust(detail, { asset, delta, ticker });
  const ready = Number.isInteger(delta) && delta !== 0 && tickerOk && reasonFeedback(reason).ok && preview.refusal === null && !action.busy;
  const go = async () => {
    const body = { asset, delta, reason, ...(asset === "shares" ? { ticker } : {}) };
    if (await action.run(() => admin.adjustPlayer(id, body, key.current))) {
      key.current = crypto.randomUUID();
      setAmount("");
      setReason("");
      await onDone();
    }
  };
  return (
    <Card title="Ajustar saldo">
      <form className="stack-s" onSubmit={(e) => { e.preventDefault(); void go(); }}>
        <div className="seg" role="group" aria-label="O que ajustar">
          <button type="button" aria-pressed={asset === "cash"} onClick={() => setAsset("cash")}>Caixa</button>
          <button type="button" aria-pressed={asset === "shares"} onClick={() => setAsset("shares")}>Ações</button>
        </div>
        <div className="seg" role="group" aria-label="Creditar ou debitar">
          <button type="button" aria-pressed={sign === 1} onClick={() => setSign(1)}>Creditar</button>
          <button type="button" aria-pressed={sign === -1} onClick={() => setSign(-1)}>Debitar</button>
        </div>
        {asset === "shares" && (
          <div className="field">
            <label htmlFor="aj-ticker">Ticker do clube</label>
            <input id="aj-ticker" className="input" value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} maxLength={6} placeholder="FLA3" />
          </div>
        )}
        <div className="field">
          <label htmlFor="aj-valor">{asset === "cash" ? "Valor em reais" : "Quantidade de ações"}</label>
          <input id="aj-valor" className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <ReasonField value={reason} onChange={setReason} id="motivo-ajuste" />
        {delta !== 0 && (
          <div className="note" aria-live="polite">
            <div>
              {preview.lines.map((l) => <div key={l}>{l}</div>)}
              {preview.refusal && <div className="err">{preview.refusal}</div>}
            </div>
          </div>
        )}
        <div className="note"><div>A casa cota com as ações livres da tesouraria: um crédito grande de ações diminui o que ela cota até a próxima reposição.</div></div>
        <ErrorNote message={action.error} />
        <button type="submit" className="btn btn-p" disabled={!ready}>Aplicar o ajuste</button>
      </form>
    </Card>
  );
}
