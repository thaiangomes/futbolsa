"use client";

import { useMemo } from "react";
import { useSession } from "../../features/accounts/session-provider";
import { Footer } from "../../features/accounts/ui/brand";
import { portfolioApi } from "../../features/portfolio/api";
import { usePositions } from "../../features/portfolio/use-positions";
import { PlayerHeader } from "../../features/accounts/ui/player-nav";
import { useProjections } from "../../features/club-value";
import { ClubList } from "../../features/market/club-list";
import { useMarketApi } from "../../features/market";

function Clubs() {
  const { state, api } = useSession();
  const wallet = useMemo(() => portfolioApi(api), [api]);
  const positions = usePositions(wallet, state.status === "ready");
  const market = useMarketApi();
  const projections = useProjections(market, state.status === "ready");
  return <ClubList api={market} positions={positions} projections={projections} />;
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
