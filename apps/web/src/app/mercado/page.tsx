"use client";

import { useSession } from "../../features/accounts/session-provider";
import { Footer, SimpleHeader } from "../../features/accounts/ui/brand";
import { ClubList } from "../../features/market/club-list";
import { useMarketApi } from "../../features/market";

function Clubs() {
  return <ClubList api={useMarketApi()} />;
}

/** A lista de clubes com preço, variação e os avisos de jogo, leilão e suspensão (D6 do plano). Pública. */
export default function MarketPage() {
  const { state } = useSession();
  const nickname = state.status === "ready" ? state.me.nickname : "";
  return (
    <div className="fb" style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <SimpleHeader
        right={
          <div className="row" style={{ gap: 12 }}>
            <span className="chip chip-live hide-sm">Jogo · dinheiro fictício</span>
            {nickname ? (
              <a href="/conta" className="row-s" style={{ textDecoration: "none" }}>
                <span className="av" aria-hidden="true">{nickname[0]?.toUpperCase()}</span>
                <span className="b small hide-sm">{nickname}</span>
              </a>
            ) : (
              <a href="/entrar" className="btn btn-sm">Entrar</a>
            )}
          </div>
        }
      />
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
