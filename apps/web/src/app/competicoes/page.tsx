"use client";

import { Footer } from "../../features/accounts/ui/brand";
import { PlayerHeader } from "../../features/accounts/ui/player-nav";
import { CompetitionsScreen } from "../../features/competitions";

/** As competições da temporada (item 11 da fila da partida de teste): uma aba por competição, com a classificação e os jogos. Pública; a aba vai na query (`?c=copa-do-brasil`). */
export default function CompetitionsPage() {
  return (
    <div className="fb" style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <PlayerHeader active="competicoes" />
      <main className="wrap stack" style={{ flex: 1, width: "100%" }}>
        <h1 className="h1">Competições</h1>
        <CompetitionsScreen />
      </main>
      <Footer />
    </div>
  );
}
