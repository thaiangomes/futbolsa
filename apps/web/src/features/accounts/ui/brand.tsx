import type { ReactNode } from "react";

/** A marca: três candles subindo num quadrado âmbar (Protótipos, identidade visual). */
export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 30 30" aria-hidden="true">
      <rect width="30" height="30" rx="8" fill="#FFB020" />
      <path d="M9 21.5V15M15 21.5V11.5M21 21.5V7.5" stroke="#1A1200" strokeWidth="1.6" strokeLinecap="round" />
      <rect x="7" y="16" width="4" height="4.5" rx="1" fill="#1A1200" />
      <rect x="13" y="12.5" width="4" height="7.5" rx="1" fill="#1A1200" />
      <rect x="19" y="9" width="4" height="10" rx="1" fill="#1A1200" />
    </svg>
  );
}

export function Wordmark({ size = 25 }: { size?: number }) {
  return (
    <span className="disp" style={{ fontSize: size, fontWeight: 700, color: "var(--text)", letterSpacing: ".02em" }}>
      Fut<span className="amber">Bolsa</span>
    </span>
  );
}

/** O topo das telas de conta: a marca, o aviso de que é um jogo e, à direita, o que a tela pedir. */
export function SimpleHeader({ right }: { right?: ReactNode }) {
  return (
    <header className="top" style={{ justifyContent: "space-between" }}>
      <a href="/" className="row-s" style={{ gap: 10, textDecoration: "none" }} aria-label="FutBolsa, início">
        <Logo />
        <Wordmark />
      </a>
      {right ?? <span className="chip chip-live">Jogo · dinheiro fictício</span>}
    </header>
  );
}

/** O rodapé de toda tela: dinheiro fictício e não afiliação (Aspectos legais). */
export function Footer() {
  return (
    <footer className="fbc" style={{ borderTop: "1px solid var(--line)", background: "var(--bg2)" }}>
      <div className="wrap row between" style={{ paddingTop: 20, paddingBottom: 24, gap: 16, alignItems: "flex-start" }}>
        <p className="small muted m0" style={{ maxWidth: 820 }}>
          FutBolsa é um jogo com dinheiro fictício: não há compra de moeda, saque nem prêmio em dinheiro. Não tem relação
          com nenhum clube, com a CBF nem com a B3. Os clubes aparecem só pelo nome em texto, pelo ticker e por um selo
          próprio, nunca pelo escudo. Horários de Brasília.
        </p>
        <nav className="row small" aria-label="Documentos" style={{ gap: 18 }}>
          <a href="/termos">Termos de uso</a>
          <a href="/privacidade">Política de privacidade</a>
        </nav>
      </div>
    </footer>
  );
}

/** Página do caminho de entrada: topo simples, um cartão centralizado e o rodapé. */
export function AuthCardPage({ children, labelledBy, maxWidth = 520 }: { children: ReactNode; labelledBy: string; maxWidth?: number }) {
  return (
    <div className="fb" style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <SimpleHeader />
      <main className="wrap" style={{ flex: 1, width: "100%", maxWidth, paddingTop: 56 }}>
        <section className="card" style={{ padding: 32 }} aria-labelledby={labelledBy}>
          <div className="stack">{children}</div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
