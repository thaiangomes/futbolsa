"use client";

import { RequireAccount } from "../../features/accounts/session-provider";
import { Footer } from "../../features/accounts/ui/brand";
import { PlayerHeader } from "../../features/accounts/ui/player-nav";
import { WalletScreen } from "../../features/portfolio";

/** A carteira do jogador (prancha 2 e a do celular): patrimônio, caixa, posições, ordens abertas e extrato. */
export default function CarteiraPage() {
  return (
    <div className="fb" style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <PlayerHeader active="carteira" />
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
