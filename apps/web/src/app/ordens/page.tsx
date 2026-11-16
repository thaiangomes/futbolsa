"use client";

import { RequireAccount } from "../../features/accounts/session-provider";
import { Footer } from "../../features/accounts/ui/brand";
import { PlayerHeader } from "../../features/accounts/ui/player-nav";
import { OrdersScreen } from "../../features/market/orders-screen";

/** As ordens abertas do jogador em todos os clubes, com editar e cancelar (item 12 das melhorias; critério 60 do livro). */
export default function OrdensPage() {
  return (
    <div className="fb" style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <PlayerHeader active="ordens" />
      <main className="wrap stack" style={{ flex: 1, width: "100%" }}>
        <h1 className="h1">Minhas ordens</h1>
        <RequireAccount>
          <OrdersScreen />
        </RequireAccount>
      </main>
      <Footer />
    </div>
  );
}
