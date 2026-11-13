"use client";

import { useSession } from "../../features/accounts/session-provider";
import { Footer, SimpleHeader } from "../../features/accounts/ui/brand";
import { RankingsScreen } from "../../features/rankings";

/** Os rankings (prancha 4): parcial do mês e da temporada, meses fechados, campeões e como é medido. Pública; o mês escolhido vai na query (`?mes=2027-06`). */
export default function RankingsPage() {
  const { state } = useSession();
  const nickname = state.status === "ready" ? state.me.nickname : "";
  return (
    <div className="fb" style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <SimpleHeader
        right={
          <div className="row" style={{ gap: 12 }}>
            <a href="/mercado" className="small b">Mercado</a>
            <a href="/carteira" className="small b">Carteira</a>
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
      <main className="wrap stack" style={{ flex: 1, width: "100%" }}>
        <h1 className="h1">Rankings</h1>
        <RankingsScreen />
      </main>
      <Footer />
    </div>
  );
}
