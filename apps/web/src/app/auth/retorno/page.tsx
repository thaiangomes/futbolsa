"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthCardPage } from "../../../features/accounts/ui/brand";
import { useSession } from "../../../features/accounts/session-provider";
import { redirectForAccountPage } from "../../../features/accounts/session";
import { linkErrorInUrl } from "../../../features/accounts/navigation";

/**
 * A volta do Google e do link de confirmação do e-mail: o login troca o código pela sessão
 * (fluxo PKCE), e esta página leva a pessoa ao próximo passo do caminho de entrada.
 */
export default function RetornoPage() {
  const { state, reload } = useSession();
  const router = useRouter();
  const [linkError, setLinkError] = useState(false);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    setLinkError(linkErrorInUrl());
    void reload().then(() => setChecked(true));
  }, [reload]);

  useEffect(() => {
    if (!checked || linkError || state.status === "loading") return;
    router.replace(redirectForAccountPage(state) ?? "/");
  }, [checked, linkError, state, router]);

  return (
    <AuthCardPage labelledBy="t-ret">
      <h1 className="h2" id="t-ret">{linkError ? "Link vencido" : "Entrando…"}</h1>
      {linkError ? (
        <div className="note note-err" role="alert">
          <div>
            Este link já foi usado ou venceu. <a href="/entrar">Entrar</a> ou <a href="/esqueci-senha">pedir outro link</a>.
          </div>
        </div>
      ) : (
        <p className="small muted m0">Conferindo o seu login.</p>
      )}
    </AuthCardPage>
  );
}
