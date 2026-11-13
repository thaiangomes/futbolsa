"use client";

import { Footer, SimpleHeader } from "../../features/accounts/ui/brand";
import { RequireAccount, useSession } from "../../features/accounts/session-provider";
import { EntryScreen, useEntryApi } from "../../features/entry";

function Entry() {
  const api = useEntryApi();
  return <EntryScreen api={api} />;
}

/** A entrada no meio da temporada (prancha 5): quem criou a conta depois do fechamento do IPO escolhe como entrar. */
export default function EntryPage() {
  const { state } = useSession();
  const nickname = state.status === "ready" ? state.me.nickname : "";
  return (
    <div className="fb" style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <SimpleHeader
        right={
          <div className="row" style={{ gap: 12 }}>
            <span className="chip chip-live hide-sm">Jogo · dinheiro fictício</span>
            {nickname && (
              <a href="/conta" className="row-s" style={{ textDecoration: "none" }}>
                <span className="av" aria-hidden="true">
                  {nickname[0]?.toUpperCase()}
                </span>
                <span className="b small hide-sm">{nickname}</span>
              </a>
            )}
          </div>
        }
      />
      <main className="wrap" style={{ flex: 1, width: "100%" }}>
        <RequireAccount>
          <section className="stack" aria-labelledby="entrada-titulo">
            <h1 className="h1" id="entrada-titulo">
              Entrar na temporada
            </h1>
            <Entry />
          </section>
        </RequireAccount>
      </main>
      <Footer />
    </div>
  );
}
