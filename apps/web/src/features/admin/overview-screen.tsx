"use client";

import { useChannel } from "../../realtime/react";
import type { AdminApi } from "./api";
import { COMPETITION_LABELS } from "./forms";
import { Card, LoadState, useLoader } from "./ui";

/** A tela inicial do admin: o que pede atenção (jogos pendentes, classificação e copas por conferir, suspensões). */
export function OverviewScreen({ admin }: { admin: AdminApi }) {
  const loader = useLoader(() => admin.overview());
  // O aviso de pendência chega pelo canal `admin`; ao chegar, a tela relê o resumo.
  useChannel("admin", { onEvent: (e) => e.type === "admin.pending" && void loader.reload() });
  const o = loader.data;
  if (!o) return <LoadState loader={loader} />;
  const items: Array<{ ok: boolean; text: string; href: string }> = [
    { ok: o.pendingMatches === 0, text: o.pendingMatches === 0 ? "Nenhum jogo pendente" : `${o.pendingMatches} jogo(s) sem placar depois do fim previsto`, href: "/admin/jogos" },
    {
      ok: o.standingsNotConfirmed.length === 0,
      text: o.standingsNotConfirmed.length === 0 ? "Classificação conferida" : `Classificação por conferir: ${o.standingsNotConfirmed.map((c) => COMPETITION_LABELS[c]).join(", ")}`,
      href: "/admin/classificacao",
    },
    {
      ok: o.cupsNotConfirmed.length === 0,
      text: o.cupsNotConfirmed.length === 0 ? "Tabelas das copas confirmadas" : `Tabela por confirmar: ${o.cupsNotConfirmed.map((c) => COMPETITION_LABELS[c]).join(", ")}`,
      href: "/admin/temporada",
    },
    {
      ok: !o.marketSuspended && o.suspendedClubs.length === 0,
      text: o.marketSuspended ? "Mercado todo suspenso" : o.suspendedClubs.length ? `Clubes suspensos: ${o.suspendedClubs.join(", ")}` : "Nenhuma suspensão",
      href: "/admin/suspensao",
    },
  ];
  return (
    <Card title="O que pede atenção">
      <ul className="stack-s" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {items.map((item) => (
          <li key={item.href} className="row between">
            <span className="row-s">
              <span className={`chip ${item.ok ? "chip-up" : "chip-down"}`}>{item.ok ? "Em dia" : "Atenção"}</span>
              <span>{item.text}</span>
            </span>
            <a href={item.href}>Abrir</a>
          </li>
        ))}
      </ul>
    </Card>
  );
}
