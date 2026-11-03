import type { ReactNode } from "react";
import { SessionProvider } from "../features/accounts/session-provider";
import { RealtimeProvider } from "../realtime/react";
import "../styles/futbolsa.css";

export const metadata = {
  title: "FutBolsa",
  description: "O jogo da bolsa dos clubes brasileiros, com dinheiro fictício",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap"
        />
      </head>
      <body className="fb" data-tema="escuro">
        {/* A sessão do login por fora; o tempo real por dentro (a T13 da F6 liga o token dela ao WebSocket). */}
        <SessionProvider>
          <RealtimeProvider>{children}</RealtimeProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
