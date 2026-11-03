"use client";

import { AuthCardPage } from "../../features/accounts/ui/brand";
import { RequestResetForm } from "../../features/accounts/password-reset";
import { useSession } from "../../features/accounts/session-provider";
import { useSiteUrl } from "../../features/accounts/navigation";

/** Esqueci a senha (prancha 6d, passos 1 e 2). */
export default function EsqueciSenhaPage() {
  const { auth } = useSession();
  const returnUrl = useSiteUrl("/nova-senha");
  return (
    <AuthCardPage labelledBy="t-senha">
      <RequestResetForm auth={auth} returnUrl={returnUrl} />
    </AuthCardPage>
  );
}
