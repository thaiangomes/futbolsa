"use client";

import { Footer } from "../../features/accounts/ui/brand";
import { PlayerHeader } from "../../features/accounts/ui/player-nav";
import { LiveGamesScreen } from "../../features/live-games";

/** Os jogos ao vivo (item 25 da fila da partida de teste): a página que a faixa do topo abre. Pública; sem item no menu. */
export default function LiveGamesPage() {
  return (
    <div className="fb" style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <PlayerHeader active="jogos" />
      <main className="wrap stack" style={{ flex: 1, width: "100%" }}>
        <h1 className="h1">Jogos ao vivo</h1>
        <LiveGamesScreen />
      </main>
      <Footer />
    </div>
  );
}
