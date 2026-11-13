"use client";

import { useState } from "react";
import { BOT_PROFILE_NAMES, MAX_BOTS_PER_PROFILE, type BotProfileName, type BotsView } from "@futbolsa/contracts";
import { formatCents } from "../../lib/format";
import type { AdminApi } from "./api";
import { Card, ErrorNote, LoadState, useAction, useLoader } from "./ui";

export const PROFILE_LABEL: Record<BotProfileName, string> = {
  dividendos: "Dividendos",
  momentum: "Momentum",
  torcedor: "Torcedor",
  aleatorio: "Aleatório",
  trader: "Trader",
  captura: "Captura de dividendo",
  analista: "Analista",
  concentrador: "Concentrador",
  antecipador: "Antecipador",
};

/** O que a mudança faz com cada perfil: quantos ligam, desligam ou nascem (bot novo só depois de religar os desligados). */
export function describeChange(current: { active: number; inactive: number }, target: number): string {
  if (target === current.active) return "Sem mudança.";
  if (target < current.active) {
    return `Desliga ${current.active - target} (os de id maior): as ordens abertas deles são canceladas e a carteira fica, recebendo dividendos.`;
  }
  const need = target - current.active;
  const revive = Math.min(need, current.inactive);
  const created = need - revive;
  const parts = [
    revive > 0 ? `Religa ${revive} desligados (id menor primeiro, com a carteira que mantiveram)` : "",
    created > 0 ? `cria ${created} novos (carteira conforme a fase da temporada)` : "",
  ].filter(Boolean);
  return `${parts.join("; ")}.`;
}

/** Bots ao vivo (Admin, "Bots", critérios 29, 30 e 35; protótipo 7k): quantos ativos por perfil e a chave "bots nos rankings". */
export function BotsScreen({ admin, seasonId }: { admin: AdminApi; seasonId: number | null }) {
  const loader = useLoader(() => admin.bots());
  const action = useAction();
  const [wanted, setWanted] = useState<Partial<Record<BotProfileName, string>>>({});
  const view = loader.data;
  if (!view) return <LoadState loader={loader} />;

  const changes = BOT_PROFILE_NAMES.flatMap((p) => {
    const text = wanted[p];
    if (text === undefined || text.trim() === "") return [];
    const n = Number(text);
    const current = view.profiles.find((x) => x.profile === p)!;
    return Number.isInteger(n) && n >= 0 && n <= MAX_BOTS_PER_PROFILE && n !== current.active ? [[p, n] as const] : [];
  });
  const apply = async () => {
    if (await action.run(() => admin.updateBots({ counts: Object.fromEntries(changes) }))) {
      setWanted({});
      await loader.reload();
    }
  };
  const toggleRankings = async (on: boolean) => {
    if (seasonId !== null && (await action.run(() => admin.patchSeason(seasonId, { botsInRankings: on })))) await loader.reload();
  };

  return (
    <div className="stack">
      <Card title="Quantos bots ativos por perfil">
        <form className="stack-s" onSubmit={(e) => { e.preventDefault(); void apply(); }}>
          <table className="tbl">
            <thead><tr><th>Perfil</th><th className="r">Ativos</th><th className="r">Desligados</th><th>Quero</th><th>O que acontece</th></tr></thead>
            <tbody>
              {view.profiles.map((p) => {
                const text = wanted[p.profile] ?? "";
                const n = Number(text);
                const valid = text.trim() !== "" && Number.isInteger(n) && n >= 0 && n <= MAX_BOTS_PER_PROFILE;
                return (
                  <tr key={p.profile}>
                    <td>{PROFILE_LABEL[p.profile]}</td><td className="r">{p.active}</td><td className="r">{p.inactive}</td>
                    <td>
                      <label className="sr-only" htmlFor={`bots-${p.profile}`}>Quantos de {PROFILE_LABEL[p.profile]}</label>
                      <input id={`bots-${p.profile}`} className="input" style={{ width: 80 }} inputMode="numeric" value={text} onChange={(e) => setWanted((w) => ({ ...w, [p.profile]: e.target.value }))} placeholder={String(p.active)} />
                    </td>
                    <td className="small muted">{valid ? describeChange(p, n) : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <ErrorNote message={action.error} />
          <button type="submit" className="btn btn-p" disabled={changes.length === 0 || action.busy}>Aplicar</button>
        </form>
      </Card>
      <Card title="Bots nos rankings">
        <p className="m0">A chave vale na hora, na parcial: {view.botsInRankings ? "os bots aparecem nos rankings, marcados como bot." : "os bots não aparecem nos rankings."} O oficial de cada mês guarda como estava no fechamento.</p>
        <button type="button" className="btn btn-sm" disabled={action.busy || seasonId === null} onClick={() => void toggleRankings(!view.botsInRankings)}>
          {view.botsInRankings ? "Desligar bots nos rankings" : "Ligar bots nos rankings"}
        </button>
      </Card>
      <BotList view={view} />
    </div>
  );
}

function BotList({ view }: { view: BotsView }) {
  const withWallet = view.profiles.flatMap((p) => p.bots.filter((b) => b.hasWallet).map((b) => ({ ...b, profile: p.profile })));
  if (withWallet.length === 0) return null;
  return (
    <Card title={`Bots com carteira nesta temporada (${withWallet.length})`}>
      <table className="tbl">
        <thead><tr><th>Bot</th><th>Perfil</th><th>Situação</th><th className="r">Patrimônio</th></tr></thead>
        <tbody>
          {withWallet.slice(0, 200).map((b) => (
            <tr key={b.id}><td>#{b.id}</td><td>{PROFILE_LABEL[b.profile]}</td><td>{b.active ? "Ativo" : "Desligado"}</td><td className="r">{b.equity === null ? "—" : formatCents(b.equity)}</td></tr>
          ))}
        </tbody>
      </table>
      {withWallet.length > 200 && <p className="muted small">Mostrando os 200 primeiros.</p>}
    </Card>
  );
}
