import type { ReactNode } from "react";
import { SessionProvider } from "../features/accounts/session-provider";
import { SuspensionBanner } from "../features/market/suspension-banner";
import { AppRealtimeProvider } from "../realtime/app-provider";
import { scriptDoRelogioPublico } from "../lib/partida/relogio-publico";
import "../styles/futbolsa.css";

// Partida de teste aberta a convidados (F17, T9): o build da Vercel traz NEXT_PUBLIC_PARTIDA=1 e o relógio do jogo vem da API.
const PARTIDA = process.env.NEXT_PUBLIC_PARTIDA === "1";
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

export const metadata = {
  title: "FutBolsa",
  description: "O jogo da bolsa dos clubes brasileiros, com dinheiro fictício",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <head>
        {PARTIDA ? <script dangerouslySetInnerHTML={{ __html: scriptDoRelogioPublico(API_URL) }} /> : null}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap"
        />
      </head>
      <body className="fb" data-tema="escuro">
        {/* A sessão do login por fora; o tempo real por dentro, com o token dela. */}
        <SessionProvider>
          <AppRealtimeProvider>
            <SuspensionBanner />
            {children}
          </AppRealtimeProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
