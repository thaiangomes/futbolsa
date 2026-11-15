"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { TICKER_PATTERN } from "@futbolsa/contracts";
import { Footer } from "../../features/accounts/ui/brand";
import { PlayerHeader } from "../../features/accounts/ui/player-nav";
import { ClubScreen } from "../../features/market";

function Club() {
  const ticker = useSearchParams().get("t") ?? "";
  if (!TICKER_PATTERN.test(ticker)) {
    return <p className="muted">Clube não encontrado. <a href="/mercado">Ver todos os clubes</a></p>;
  }
  return <ClubScreen ticker={ticker} />;
}

/**
 * A tela de um clube (prancha 1): o ticker vem no endereço (`/clube?t=FLA3`), e não numa página por clube, para o site
 * estático não precisar de build novo a cada clube listado (P6 do plano). O livro e os negócios são públicos.
 */
export default function ClubPage() {
  return (
    <div className="fb" style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <PlayerHeader active="mercado" />
      <main className="wrap" style={{ flex: 1, width: "100%" }}>
        <Suspense fallback={<p className="muted">Carregando…</p>}>
          <Club />
        </Suspense>
      </main>
      <Footer />
    </div>
  );
}
