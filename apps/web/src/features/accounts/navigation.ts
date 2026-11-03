"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "./session-provider";
import { redirectForAuthPage } from "./session";

/** O endereço completo de uma página do site (para o Google e os links de e-mail voltarem). */
export function useSiteUrl(path: string): string {
  const [url, setUrl] = useState(path);
  useEffect(() => setUrl(`${window.location.origin}${path}`), [path]);
  return url;
}

/** Nas páginas do caminho de entrada: quem já está mais à frente vai para onde deve. */
export function useAuthPageRedirect(page: string): void {
  const { state } = useSession();
  const router = useRouter();
  const target = redirectForAuthPage(state, page);
  useEffect(() => {
    if (target) router.replace(target);
  }, [router, target]);
}

/** Erro devolvido pelo login na URL (link vencido ou já usado), na consulta ou depois do `#`. */
export function linkErrorInUrl(): boolean {
  const params = new URLSearchParams(`${window.location.search.replace(/^\?/, "")}&${window.location.hash.replace(/^#/, "")}`);
  return Boolean(params.get("error") || params.get("error_code"));
}
