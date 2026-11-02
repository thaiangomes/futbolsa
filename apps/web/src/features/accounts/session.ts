import { meResponseSchema, type MeResponse } from "@futbolsa/contracts";
import { ApiError, type ApiClient } from "../../lib/api";
import type { AuthClient } from "../../lib/auth";

export type RegisteredMe = Extract<MeResponse, { registered: true }>;

/** Onde a pessoa está no caminho entrar → confirmar o e-mail → convite → cadastro → jogar. */
export type SessionState =
  | { status: "loading" }
  | { status: "signed_out" }
  | { status: "email_not_confirmed" }
  | { status: "uninvited" }
  | { status: "unregistered" }
  | { status: "deleted" }
  | { status: "ready"; me: RegisteredMe };

/** Lê a sessão do login e a conta do jogo (`GET /me`). */
export async function loadSession(auth: AuthClient, api: ApiClient): Promise<SessionState> {
  if (!(await auth.getAccessToken())) return { status: "signed_out" };
  let me: MeResponse;
  try {
    me = await api.request(meResponseSchema, "/me");
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.code === "invalid_token") return { status: "signed_out" };
      if (error.code === "email_not_confirmed") return { status: "email_not_confirmed" };
      if (error.code === "account_deleted") return { status: "deleted" };
    }
    throw error;
  }
  if (!me.registered) return { status: me.invited ? "unregistered" : "uninvited" };
  return { status: "ready", me };
}

/** As páginas do caminho de entrada, que não pedem conta. */
export const AUTH_PAGES = [
  "/entrar",
  "/criar-conta",
  "/confirmar-email",
  "/esqueci-senha",
  "/nova-senha",
  "/auth/retorno",
  "/sem-convite",
  "/cadastro",
  "/termos",
  "/privacidade",
] as const;

/**
 * Para onde mandar quem abre uma página que pede conta do jogo, ou `null` se pode ficar. A
 * proteção de verdade é a da API; esta só leva a pessoa à página certa do caminho.
 */
export function redirectForAccountPage(state: SessionState): string | null {
  switch (state.status) {
    case "loading":
    case "ready":
      return null;
    case "signed_out":
    case "deleted":
      return "/entrar";
    case "email_not_confirmed":
      return "/confirmar-email";
    case "uninvited":
      return "/sem-convite";
    case "unregistered":
      return "/cadastro";
  }
}

/** Para onde mandar quem já tem conta pronta e abre entrar, criar conta ou cadastro. */
export function redirectForAuthPage(state: SessionState, page: string): string | null {
  if (state.status === "ready" && ["/entrar", "/criar-conta", "/cadastro", "/sem-convite"].includes(page)) return "/";
  if (state.status === "unregistered" && page === "/sem-convite") return "/cadastro";
  return null;
}
