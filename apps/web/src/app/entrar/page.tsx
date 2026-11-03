"use client";

import { useRouter } from "next/navigation";
import { Footer, Logo, Wordmark } from "../../features/accounts/ui/brand";
import { LoginForm } from "../../features/accounts/login-form";
import { useSession } from "../../features/accounts/session-provider";
import { useAuthPageRedirect, useSiteUrl } from "../../features/accounts/navigation";

/** Entrar (prancha 6a). As cotações do protótipo entram quando a API do mercado existir (F9). */
export default function EntrarPage() {
  const { auth } = useSession();
  const router = useRouter();
  const returnUrl = useSiteUrl("/auth/retorno");
  useAuthPageRedirect("/entrar");
  return (
    <div className="fb" style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <main className="wrap g-2" style={{ flex: 1, alignItems: "center", gap: 48, paddingTop: 48, paddingBottom: 48, width: "100%" }}>
        <section className="stack" style={{ gap: 24 }} aria-label="Sobre o FutBolsa">
          <div className="row-s" style={{ gap: 12 }}>
            <Logo size={44} />
            <Wordmark size={36} />
          </div>
          <span className="chip chip-live" style={{ alignSelf: "flex-start", height: 30, fontSize: 13, padding: "0 12px" }}>
            É um jogo · dinheiro fictício
          </span>
          <h1 className="h1" style={{ fontSize: 52, maxWidth: 600 }}>O jogo da bolsa dos clubes brasileiros.</h1>
          <p className="muted m0" style={{ fontSize: 17, maxWidth: 540 }}>
            Um jogo para aprender a investir de um jeito divertido. Cada clube é uma ação: entre no IPO, negocie no livro de
            ofertas com a bola rolando, receba dividendos pelas vitórias e dispute o ranking com os amigos. Todo o dinheiro é
            de mentira.
          </p>
          <div className="row" style={{ gap: 8 }}>
            <span className="chip">Jogo, não investimento</span>
            <span className="chip">Sem compra, saque ou prêmio</span>
            <span className="chip">Só com convite</span>
          </div>
        </section>
        <section className="card" style={{ padding: 32, maxWidth: 460, width: "100%", justifySelf: "center" }} aria-labelledby="t-entrar">
          <LoginForm auth={auth} returnUrl={returnUrl} onSignedIn={() => router.replace("/auth/retorno")} />
        </section>
      </main>
      <Footer />
    </div>
  );
}
