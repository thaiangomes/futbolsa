import type { ReactNode } from "react";
import { LEGAL_CONTACT, LEGAL_VERSION } from "../legal";
import { Footer, SimpleHeader } from "./brand";

/**
 * Página dos termos de uso e da política de privacidade (W7), com o texto completo aprovado
 * pelo Thaian em 2026-11-08 e a data da versão no topo.
 */
export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="fb" style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <SimpleHeader />
      <main className="wrap stack" style={{ flex: 1, maxWidth: 760, width: "100%", paddingTop: 40, gap: 20 }}>
        <div className="stack-s">
          <h1 className="h1">{title}</h1>
          <p className="small muted m0">
            Versão de <time dateTime={LEGAL_VERSION.date}>{LEGAL_VERSION.label}</time>.
          </p>
        </div>
        <article className="card card-b stack" style={{ gap: 20, lineHeight: 1.55 }}>{children}</article>
      </main>
      <Footer />
    </div>
  );
}

/** Uma seção numerada do texto. */
export function LegalSection({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="stack-s">
      <h2 className="h3">{n}. {title}</h2>
      {children}
    </section>
  );
}

/** Lista do texto, no mesmo estilo nas duas páginas. */
export function LegalList({ children }: { children: ReactNode }) {
  return <ul className="stack-s m0" style={{ paddingLeft: 18, gap: 6 }}>{children}</ul>;
}

/** O e-mail de contato, como link. */
export function ContactLink() {
  return <a href={`mailto:${LEGAL_CONTACT}`}>{LEGAL_CONTACT}</a>;
}
