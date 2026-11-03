"use client";

import { AuthCardPage } from "../../features/accounts/ui/brand";
import { CreateLoginForm } from "../../features/accounts/create-login-form";
import { useSession } from "../../features/accounts/session-provider";
import { useAuthPageRedirect, useSiteUrl } from "../../features/accounts/navigation";

/** Primeiro acesso com e-mail e senha (W3; sem prancha própria, no estilo da 6d). */
export default function CriarContaPage() {
  const { auth } = useSession();
  const returnUrl = useSiteUrl("/auth/retorno");
  useAuthPageRedirect("/criar-conta");
  return (
    <AuthCardPage labelledBy="t-criar">
      <CreateLoginForm auth={auth} returnUrl={returnUrl} />
    </AuthCardPage>
  );
}
