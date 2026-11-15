"use client";

import { Footer } from "../../features/accounts/ui/brand";
import { PlayerHeader } from "../../features/accounts/ui/player-nav";
import { RankingsScreen } from "../../features/rankings";

/** Os rankings (prancha 4): parcial do mês e da temporada, meses fechados, campeões e como é medido. Pública; o mês escolhido vai na query (`?mes=2027-06`). */
export default function RankingsPage() {
  return (
    <div className="fb" style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <PlayerHeader active="rankings" />
      <main className="wrap stack" style={{ flex: 1, width: "100%" }}>
        <h1 className="h1">Rankings</h1>
        <RankingsScreen />
      </main>
      <Footer />
    </div>
  );
}
