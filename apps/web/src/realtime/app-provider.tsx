"use client";

import { createElement, type ReactNode } from "react";
import { useSession } from "../features/accounts/session-provider";
import { RealtimeProvider } from "./react";

/**
 * O tempo real do site com o login da sessão (F5): o token vem do `AuthClient` da sessão, e
 * entrar ou sair reabre a conexão. É um componente de cliente à parte porque o `layout.tsx`
 * (servidor) não pode passar o objeto de login como propriedade. Vai dentro do `SessionProvider`.
 */
export function AppRealtimeProvider({ children }: { children: ReactNode }) {
  const { auth } = useSession();
  return createElement(RealtimeProvider, { auth, children });
}
