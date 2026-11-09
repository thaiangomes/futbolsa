"use client";

import { Footer, SimpleHeader } from "../../features/accounts/ui/brand";
import { RequireAccount, useSession } from "../../features/accounts/session-provider";
import { IpoScreen, useIpoApi } from "../../features/ipo";

function Ipo() {
  const api = useIpoApi();
  return <IpoScreen api={api} />;
}

/** O IPO dos clubes (pranchas 3 e 3b): o período de ofertas e, depois da liquidação, o resultado do rateio. */
export default function IpoPage() {
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
                <span className="av" aria-hidden="true">{nickname[0]?.toUpperCase()}</span>
                <span className="b small hide-sm">{nickname}</span>
              </a>
            )}
          </div>
        }
      />
      <main className="wrap" style={{ flex: 1, width: "100%" }}>
        <RequireAccount>
          <section className="stack" aria-labelledby="ipo-titulo">
            <h1 className="h1" id="ipo-titulo">IPO dos clubes</h1>
            <Ipo />
          </section>
        </RequireAccount>
      </main>
      <Footer />
    </div>
  );
}
