"use client";

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiClient } from "../../lib/api";
import { type AuthClient, getAuthClient } from "../../lib/auth";
import { loadSession, redirectForAccountPage, type SessionState } from "./session";

interface SessionContextValue {
  state: SessionState;
  auth: AuthClient;
  api: ApiClient;
  /** Lê de novo a conta (depois do cadastro, da troca de apelido ou da exclusão). */
  reload(): Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

/** Guarda a sessão do login e a conta do jogo para todas as páginas, e relê quando o login muda. */
export function SessionProvider({ children, auth = getAuthClient() }: { children: ReactNode; auth?: AuthClient }) {
  const api = useMemo(() => new ApiClient({ baseUrl: API_URL, auth }), [auth]);
  const [state, setState] = useState<SessionState>({ status: "loading" });

  const reload = useCallback(async () => {
    try {
      setState(await loadSession(auth, api));
    } catch {
      setState({ status: "signed_out" });
    }
  }, [auth, api]);

  useEffect(() => {
    void reload();
    return auth.onChange(() => void reload());
  }, [auth, reload]);

  const value = useMemo(() => ({ state, auth, api, reload }), [state, auth, api, reload]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession fora do SessionProvider");
  return value;
}

/** Envolve as páginas que pedem conta do jogo: leva a pessoa à página certa do caminho de entrada. */
export function RequireAccount({ children }: { children: ReactNode }) {
  const { state } = useSession();
  const router = useRouter();
  const target = redirectForAccountPage(state);
  useEffect(() => {
    if (target) router.replace(target);
  }, [router, target]);
  if (state.status !== "ready") return null;
  return <>{children}</>;
}
