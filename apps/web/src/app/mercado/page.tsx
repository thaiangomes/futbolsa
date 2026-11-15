"use client";

import { Footer } from "../../features/accounts/ui/brand";
import { PlayerHeader } from "../../features/accounts/ui/player-nav";
import { ClubList } from "../../features/market/club-list";
import { useMarketApi } from "../../features/market";

function Clubs() {
  return <ClubList api={useMarketApi()} />;
}

/** A lista de clubes com preço, variação e os avisos de jogo, leilão e suspensão (D6 do plano). Pública. */
export default function MarketPage() {
  return (
    <div className="fb" style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <PlayerHeader active="mercado" />
      <main className="wrap" style={{ flex: 1, width: "100%" }}>
        <section className="stack" aria-labelledby="mercado-titulo">
          <h1 className="h1" id="mercado-titulo">Mercado</h1>
          <Clubs />
        </section>
      </main>
      <Footer />
    </div>
  );
}
