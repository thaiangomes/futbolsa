import type { ReactNode } from "react";
import { AppRealtimeProvider } from "../realtime/app-provider";

export const metadata = {
  title: "FutBolsa",
  description: "Bolsa fictícia com clubes de futebol brasileiros",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>
        <AppRealtimeProvider>{children}</AppRealtimeProvider>
      </body>
    </html>
  );
}
