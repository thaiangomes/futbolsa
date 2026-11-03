"use client";

import { useRouter } from "next/navigation";
import { AuthCardPage } from "../../features/accounts/ui/brand";
import { useSession } from "../../features/accounts/session-provider";
import { useAuthPageRedirect } from "../../features/accounts/navigation";

/** Entrou, mas o e-mail não foi liberado pelo admin (Conta e login, critério 1). */
export default function SemConvitePage() {
  const { auth } = useSession();
  const router = useRouter();
  useAuthPageRedirect("/sem-convite");
  return (
    <AuthCardPage labelledBy="t-conv">
      <h1 className="h2" id="t-conv">Falta o convite</h1>
      <div className="note">
        <div>O FutBolsa é só com convite. Peça a quem te chamou para o jogo que o admin libere o seu e-mail. Depois, é só entrar de novo.</div>
      </div>
      <p className="xs muted m0">Entrou com outro e-mail? Saia e entre com o endereço que foi liberado.</p>
      <button type="button" className="btn btn-lg btn-full" onClick={() => void auth.signOut().then(() => router.replace("/entrar"))}>
        Sair e entrar com outro e-mail
      </button>
    </AuthCardPage>
  );
}
