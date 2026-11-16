"use client";

import type { ReactNode } from "react";
import { useSession } from "../session-provider";
import { Logo, Wordmark } from "./brand";

/** As telas do jogador que o menu liga. `perfil` é a Conta (avatar no computador, última aba no celular). */
export type PlayerPage = "mercado" | "carteira" | "ipo" | "rankings" | "competicoes" | "perfil";

interface Item {
  id: Exclude<PlayerPage, "perfil">;
  label: string;
  href: string;
  icon: ReactNode;
}

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;

/** A ordem e os ícones são os do protótipo (componentes Topo e TabBar): Mercado, Carteira, IPO, Rankings e Competições. */
export const PLAYER_MENU: readonly Item[] = [
  { id: "mercado", label: "Mercado", href: "/mercado", icon: <><path d="M3 17l5-5 4 3 8-8" /><path d="M15 7h5v5" /></> },
  { id: "carteira", label: "Carteira", href: "/carteira", icon: <><rect x="3" y="6" width="18" height="13" rx="2" /><path d="M3 10h18M16 14.5h2" /></> },
  { id: "ipo", label: "IPO", href: "/ipo", icon: <><path d="M12 3v4M5 8l2.5 2.5M19 8l-2.5 2.5" /><rect x="6" y="12" width="12" height="8" rx="2" /></> },
  { id: "rankings", label: "Rankings", href: "/rankings", icon: <><path d="M8 4h8v5a4 4 0 0 1-8 0z" /><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8.5 20h7" /></> },
  { id: "competicoes", label: "Competições", href: "/competicoes", icon: <><circle cx="12" cy="12" r="9" /><path d="M12 3v18M3 12h18" /></> },
];

const current = (active: PlayerPage, id: PlayerPage) => (active === id ? ("page" as const) : undefined);

/**
 * O menu do jogador (Protótipos, componentes Topo e TabBar). No computador, a barra do topo com a marca, os itens e a Conta
 * à direita; no celular, as abas fixas na base. O item da página atual fica destacado. Não vai nas telas de entrada.
 */
export function PlayerHeader({ active }: { active: PlayerPage }) {
  const { state } = useSession();
  const me = state.status === "ready" ? state.me : null;
  return (
    <>
      <header className="top" data-testid="menu-topo">
        <a href="/mercado" className="row-s" style={{ gap: 10, textDecoration: "none" }} aria-label="FutBolsa, início">
          <Logo />
          <Wordmark />
        </a>
        <nav className="nav hide-sm" aria-label="Principal">
          {PLAYER_MENU.map((i) => (
            <a key={i.id} href={i.href} aria-current={current(active, i.id)}>{i.label}</a>
          ))}
          {me?.role === "admin" && <a href="/admin">Admin</a>}
        </nav>
        <div className="grow" />
        <span className="chip chip-live hide-sm">Jogo · dinheiro fictício</span>
        {me ? (
          <a href="/conta" className="row-s" style={{ textDecoration: "none", color: "var(--text)" }} aria-current={current(active, "perfil")} aria-label={`Minha conta, ${me.nickname}`}>
            <span className="av" aria-hidden="true">{me.nickname[0]?.toUpperCase()}</span>
            <span className="b small hide-sm">{me.nickname}</span>
          </a>
        ) : (
          <a href="/entrar" className="btn btn-sm">Entrar</a>
        )}
      </header>
      <TabBar active={active} signedIn={me !== null} />
    </>
  );
}

/** As abas do celular, presas na base da tela (só aparecem em telas estreitas). */
export function TabBar({ active, signedIn }: { active: PlayerPage; signedIn: boolean }) {
  return (
    <nav className="tabbar tabbar-fixed" aria-label="Principal" data-testid="menu-abas">
      {PLAYER_MENU.map((i) => (
        <a key={i.id} href={i.href} aria-current={current(active, i.id)}>
          <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>{i.icon}</svg>
          {i.label}
        </a>
      ))}
      <a href={signedIn ? "/conta" : "/entrar"} aria-current={current(active, "perfil")}>
        <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" {...stroke}><circle cx="12" cy="8" r="4" /><path d="M4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5" /></svg>
        {signedIn ? "Perfil" : "Entrar"}
      </a>
    </nav>
  );
}
