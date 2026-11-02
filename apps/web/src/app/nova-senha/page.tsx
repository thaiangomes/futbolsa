"use client";

import { useEffect, useState } from "react";
import { AuthCardPage } from "../../features/accounts/ui/brand";
import { NewPasswordForm } from "../../features/accounts/password-reset";
import { useSession } from "../../features/accounts/session-provider";
import { linkErrorInUrl } from "../../features/accounts/navigation";

/** Nova senha (prancha 6d, passo 3), aberta pelo link do e-mail, que já deixa a pessoa logada. */
export default function NovaSenhaPage() {
  const { auth } = useSession();
  const [valid, setValid] = useState<boolean | null>(null);
  useEffect(() => {
    if (linkErrorInUrl()) {
      setValid(false);
      return;
    }
    void auth.getAccessToken().then(
      (token) => setValid(Boolean(token)),
      () => setValid(false),
    );
  }, [auth]);
  return (
    <AuthCardPage labelledBy="t-senha">
      {valid === null ? (
        <p className="small muted m0" id="t-senha">Conferindo o link…</p>
      ) : (
        <NewPasswordForm auth={auth} linkValid={valid} />
      )}
    </AuthCardPage>
  );
}
