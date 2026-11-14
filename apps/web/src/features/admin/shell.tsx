"use client";

import { type ReactNode, useMemo } from "react";
import { usePathname } from "next/navigation";
import { Footer, SimpleHeader } from "../accounts/ui/brand";
import { RequireAccount, useSession } from "../accounts/session-provider";
import { type AdminApi, adminApi } from "./api";

export const ADMIN_MENU = [
  { href: "/admin", label: "Visão geral" },
  { href: "/admin/jogos", label: "Jogos e pendências" },
  { href: "/admin/classificacao", label: "Classificação oficial" },
  { href: "/admin/jogadores", label: "Jogadores" },
  { href: "/admin/negocios", label: "Auditoria de negócios" },
  { href: "/admin/trapaca", label: "Trapaça entre contas" },
  { href: "/admin/bots", label: "Bots" },
  { href: "/admin/pagamentos", label: "Pagamentos" },
  { href: "/admin/pagamentos/correcao", label: "Correção de pagamentos" },
  { href: "/admin/temporada", label: "Preparar a temporada" },
  { href: "/admin/temporada/encerrar", label: "Encerrar a temporada" },
  { href: "/admin/suspensao", label: "Suspensão" },
  { href: "/admin/formador", label: "Formador de mercado" },
  { href: "/admin/registro", label: "Registro do admin" },
] as const;

/** Só admin ativo vê o conteúdo; a proteção de verdade é a da API, que recusa quem não é admin em toda rota de `/admin`. */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { state } = useSession();
  return (
    <RequireAccount>
      {state.status === "ready" && state.me.role !== "admin" ? (
        <div className="note note-err" role="alert">
          <div>Só o admin pode ver esta página.</div>
        </div>
      ) : (
        children
      )}
    </RequireAccount>
  );
}

/** O cliente das rotas do admin, ligado à sessão. */
export function useAdminApi(): AdminApi {
  const { api } = useSession();
  return useMemo(() => adminApi(api), [api]);
}

/** O layout de `/admin`: o topo do jogo, o menu lateral do admin e a página. */
export function AdminShell({ title, children }: { title: string; children: ReactNode }) {
  const { state } = useSession();
  const pathname = usePathname();
  const nickname = state.status === "ready" ? state.me.nickname : "";
  return (
    <div className="fb" style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <SimpleHeader
        right={
          <div className="row" style={{ gap: 12 }}>
            <span className="chip chip-live hide-sm">Admin · jogo com dinheiro fictício</span>
            {nickname && <span className="b small hide-sm">{nickname}</span>}
          </div>
        }
      />
      <main className="wrap" style={{ flex: 1, width: "100%" }}>
        <RequireAdmin>
          <div className="g-side">
            <nav className="side-nav" aria-label="Menu do admin">
              {ADMIN_MENU.map((item) => (
                <a key={item.href} href={item.href} aria-current={pathname === item.href || pathname === `${item.href}/` ? "page" : undefined}>
                  {item.label}
                </a>
              ))}
            </nav>
            <section className="stack" aria-labelledby="admin-titulo">
              <h1 className="h1" id="admin-titulo">{title}</h1>
              {children}
            </section>
          </div>
        </RequireAdmin>
      </main>
      <Footer />
    </div>
  );
}
