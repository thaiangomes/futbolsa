import type { ReactNode } from "react";

export const metadata = {
  title: "FutBolsa",
  description: "Bolsa fictícia com clubes de futebol brasileiros",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
