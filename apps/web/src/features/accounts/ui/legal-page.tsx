import type { ReactNode } from "react";
import { Footer, SimpleHeader } from "./brand";

/**
 * Termos de uso e política de privacidade (W7). O texto completo ainda não foi escrito nem
 * aprovado pelo Thaian (Plano de login e contas, "Pendente de informação"); até lá, a página
 * mostra o resumo aprovado na prancha 6b e diz que a versão completa vem depois.
 */
export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="fb" style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <SimpleHeader />
      <main className="wrap stack" style={{ flex: 1, maxWidth: 760, width: "100%", paddingTop: 40, gap: 20 }}>
        <h1 className="h1">{title}</h1>
        <div className="note"><div>Versão resumida. O texto completo está sendo preparado e substitui este resumo antes de o jogo abrir para mais gente.</div></div>
        <section className="card card-b stack small" style={{ gap: 12 }}>{children}</section>
      </main>
      <Footer />
    </div>
  );
}

/** Os pontos aceitos no cadastro (prancha 6b). */
export function SummaryItems() {
  return (
    <ul className="stack-s m0" style={{ paddingLeft: 18, gap: 8 }}>
      <li>O dinheiro do jogo é <strong>fictício</strong>: não dá para comprar, sacar nem trocar por prêmio.</li>
      <li>O FutBolsa <strong>não tem relação</strong> com nenhum clube, com a CBF nem com a B3. Os clubes aparecem só pelo nome em texto, pelo ticker e por um selo próprio, nunca pelo escudo.</li>
      <li>Guardamos só o seu e-mail, o apelido, a data do aceite e o seu histórico no jogo. Nada de nome, foto ou idade. Seu e-mail fica privado: só você e o admin veem.</li>
      <li>Você pode excluir sua conta quando quiser, no seu perfil. As ações vão para a tesouraria da casa, o caixa some e o e-mail e o apelido são apagados.</li>
    </ul>
  );
}
