"use client";

import { RequireAccount, useSession } from "../../features/accounts/session-provider";
import { Footer, SimpleHeader } from "../../features/accounts/ui/brand";
import { WalletScreen } from "../../features/portfolio";

/** A carteira do jogador (prancha 2 e a do celular): patrimônio, caixa, posições, ordens abertas e extrato. */
export default function CarteiraPage() {
  const { state } = useSession();
  const nickname = state.status === "ready" ? state.me.nickname : "";
  return (
    <div className="fb" style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <SimpleHeader
        right={
          <div className="row" style={{ gap: 12 }}>
            <a href="/mercado" className="small b">Mercado</a>
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
        <h1 className="h1">Carteira</h1>
        <RequireAccount>
          <WalletScreen />
        </RequireAccount>
      </main>
      <Footer />
    </div>
  );
}
