"use client";

import { useRouter } from "next/navigation";
import { AuthCardPage } from "../../features/accounts/ui/brand";
import { useSession } from "../../features/accounts/session-provider";

/** Quem tem login sem o e-mail confirmado (Conta e login, critério 5). */
export default function ConfirmarEmailPage() {
  const { auth } = useSession();
  const router = useRouter();
  return (
    <AuthCardPage labelledBy="t-conf">
      <h1 className="h2" id="t-conf">Confirme o seu e-mail</h1>
      <div className="note">
        <div>Abra o link que enviamos para o seu e-mail. Sem a confirmação, não dá para entrar no jogo. Confira também a caixa de spam.</div>
      </div>
      <button type="button" className="btn btn-lg btn-full" onClick={() => void auth.signOut().then(() => router.replace("/entrar"))}>
        Voltar para entrar
      </button>
    </AuthCardPage>
  );
}
