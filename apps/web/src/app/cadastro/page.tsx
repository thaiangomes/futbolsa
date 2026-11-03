"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Footer, SimpleHeader } from "../../features/accounts/ui/brand";
import { SignupForm } from "../../features/accounts/signup-form";
import { useSession } from "../../features/accounts/session-provider";
import { redirectForAccountPage } from "../../features/accounts/session";

/** Cadastro (prancha 6b): só para quem entrou, tem convite e ainda não tem conta do jogo. */
export default function CadastroPage() {
  const { state, api, reload } = useSession();
  const router = useRouter();
  // depois de criar, a tela de "tudo pronto" fica até a pessoa continuar
  const [created, setCreated] = useState(false);
  useEffect(() => {
    if (created || state.status === "loading" || state.status === "unregistered") return;
    router.replace(state.status === "ready" ? "/" : (redirectForAccountPage(state) ?? "/entrar"));
  }, [created, state, router]);

  return (
    <div className="fb" style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <SimpleHeader right={<span className="small muted">Primeiro acesso · passo 1 de 1</span>} />
      <main className="wrap" style={{ flex: 1, maxWidth: 720, width: "100%", paddingTop: 40 }}>
        {(state.status === "unregistered" || created) && (
          <SignupForm api={api} onCreated={() => setCreated(true)} onContinue={() => void reload().then(() => router.replace("/"))} />
        )}
      </main>
      <Footer />
    </div>
  );
}
