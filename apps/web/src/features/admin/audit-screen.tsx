"use client";

import { useState } from "react";
import type { AuditResponse, AuditTrade, TradeParty } from "@futbolsa/contracts";
import { formatCents, formatInstant, formatInt } from "../../lib/format";
import type { AdminApi } from "./api";
import { Card, ErrorNote, useAction } from "./ui";

/** Um lado do negócio: o apelido, o bot marcado, "casa" ou "conta excluída". */
export function PartyLabel({ party }: { party: TradeParty }) {
  if (party.kind === "bot") return <span><span className="chip">bot</span> {party.label}</span>;
  if (party.kind === "house") return <span className="chip">casa</span>;
  if (party.kind === "deleted") return <span className="muted">conta excluída</span>;
  return <span>{party.label}</span>;
}

/** O instante digitado em horário de Brasília (UTC−3) como ISO para a rota, que fala UTC. */
export function brasiliaToIso(local: string): string | undefined {
  if (!local) return undefined;
  const d = new Date(`${local}:00-03:00`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Auditoria de negócios (Admin, critério 34; protótipo 7j): filtros de jogador, par de contas, clube e período. */
export function AuditScreen({ admin }: { admin: AdminApi }) {
  const [player, setPlayer] = useState("");
  const [pairA, setPairA] = useState("");
  const [pairB, setPairB] = useState("");
  const [club, setClub] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [rows, setRows] = useState<AuditTrade[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const search = useAction();

  const query = () => ({
    ...(player.trim() ? { player: player.trim() } : {}),
    ...(pairA.trim() && pairB.trim() ? { pair: `${pairA.trim()},${pairB.trim()}` } : {}),
    ...(club.trim() ? { club: club.trim().toUpperCase() } : {}),
    ...(brasiliaToIso(from) ? { from: brasiliaToIso(from) } : {}),
    ...(brasiliaToIso(to) ? { to: brasiliaToIso(to) } : {}),
  });
  const apply = (page: AuditResponse, append: boolean) => {
    setRows((old) => (append && old ? [...old, ...page.trades] : page.trades));
    setCursor(page.nextCursor);
  };
  const run = () => search.run(async () => apply(await admin.trades(query()), false));
  const more = () => search.run(async () => apply(await admin.trades({ ...query(), ...(cursor ? { cursor } : {}) }), true));

  return (
    <div className="stack">
      <Card title="Filtros">
        <form className="stack-s" onSubmit={(e) => { e.preventDefault(); void run(); }}>
          <div className="field">
            <label htmlFor="f-jogador">Jogador (id da conta, bot:número ou house)</label>
            <input id="f-jogador" className="input" value={player} onChange={(e) => setPlayer(e.target.value)} />
          </div>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <div className="field" style={{ flex: 1, minWidth: 200 }}>
              <label htmlFor="f-par-a">Par de contas: primeira</label>
              <input id="f-par-a" className="input" value={pairA} onChange={(e) => setPairA(e.target.value)} />
            </div>
            <div className="field" style={{ flex: 1, minWidth: 200 }}>
              <label htmlFor="f-par-b">Par de contas: segunda</label>
              <input id="f-par-b" className="input" value={pairB} onChange={(e) => setPairB(e.target.value)} />
            </div>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <div className="field"><label htmlFor="f-clube">Clube</label><input id="f-clube" className="input" value={club} onChange={(e) => setClub(e.target.value)} maxLength={6} placeholder="CAP3" /></div>
            <div className="field"><label htmlFor="f-de">De (Brasília)</label><input id="f-de" type="datetime-local" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
            <div className="field"><label htmlFor="f-ate">Até (Brasília)</label><input id="f-ate" type="datetime-local" className="input" value={to} onChange={(e) => setTo(e.target.value)} /></div>
          </div>
          <ErrorNote message={search.error} />
          <button type="submit" className="btn btn-p" disabled={search.busy}>Buscar negócios</button>
        </form>
      </Card>
      {rows && (
        <Card title={`Negócios (${rows.length}${cursor ? "+" : ""})`}>
          {rows.length === 0 ? (
            <p className="m0 muted">Nenhum negócio com esses filtros.</p>
          ) : (
            <table className="tbl">
              <thead><tr><th>Quando</th><th>Clube</th><th className="r">Ações</th><th className="r">Preço</th><th className="r">Valor</th><th>Comprador</th><th>Vendedor</th></tr></thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id}>
                    <td>{formatInstant(t.at)}{t.inAuction ? " · leilão" : ""}</td><td>{t.ticker}</td><td className="r">{formatInt(t.quantity)}</td>
                    <td className="r">{formatCents(t.price)}</td><td className="r">{formatCents(t.value)}</td>
                    <td><PartyLabel party={t.buyer} /></td><td><PartyLabel party={t.seller} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {cursor && <button type="button" className="btn btn-sm" disabled={search.busy} onClick={() => void more()}>Mostrar mais</button>}
        </Card>
      )}
      <div className="note"><div>O comprador e o vendedor só aparecem aqui: o jogador nunca vê a contraparte, nem no livro, nem no extrato.</div></div>
    </div>
  );
}
