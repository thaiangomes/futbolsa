"use client";

import { Footer } from "../../features/accounts/ui/brand";
import { PlayerHeader } from "../../features/accounts/ui/player-nav";
import { RequireAccount } from "../../features/accounts/session-provider";
import { IpoScreen, useIpoApi } from "../../features/ipo";

function Ipo() {
  const api = useIpoApi();
  return <IpoScreen api={api} />;
}

/** O IPO dos clubes (pranchas 3 e 3b): o período de ofertas e, depois da liquidação, o resultado do rateio. */
export default function IpoPage() {
  return (
    <div className="fb" style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <PlayerHeader active="ipo" />
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
