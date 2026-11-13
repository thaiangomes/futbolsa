import { describe, expect, it } from "vitest";
import { ApiError, type ApiClient } from "../../lib/api";
import type { AuthClient } from "../../lib/auth";
import { loadSession, redirectForAccountPage, redirectForAuthPage, type SessionState } from "./session";

const ready: SessionState = {
  status: "ready",
  me: {
    registered: true,
    id: "u1",
    nickname: "anagol",
    email: "ana@exemplo.com",
    role: "player",
    status: "active",
    termsAcceptedAt: "2027-03-20T12:00:00.000Z",
    pendingNotices: [],
    season: null,
  },
};

const auth = (token: string | null) => ({ getAccessToken: async () => token }) as unknown as AuthClient;
const api = (result: unknown) =>
  ({
    request: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  }) as unknown as ApiClient;

describe("sessão e porta das páginas", () => {
  it("sem sessão no login: signed_out, sem chamar a API", async () => {
    expect(await loadSession(auth(null), api(new Error("não devia chamar")))).toEqual({ status: "signed_out" });
  });

  it("conta 1: logado sem convite vai para /sem-convite; com convite, para /cadastro", async () => {
    const uninvited = await loadSession(auth("t"), api({ registered: false, invited: false }));
    expect(uninvited).toEqual({ status: "uninvited" });
    expect(redirectForAccountPage(uninvited)).toBe("/sem-convite");
    const unregistered = await loadSession(auth("t"), api({ registered: false, invited: true }));
    expect(redirectForAccountPage(unregistered)).toBe("/cadastro");
  });

  it("conta 5: e-mail não confirmado vai para /confirmar-email", async () => {
    const state = await loadSession(auth("t"), api(new ApiError(403, "email_not_confirmed", "x")));
    expect(redirectForAccountPage(state)).toBe("/confirmar-email");
  });

  it("token recusado ou conta excluída vão para /entrar", async () => {
    expect(redirectForAccountPage(await loadSession(auth("t"), api(new ApiError(401, "invalid_token", "x"))))).toBe("/entrar");
    expect(redirectForAccountPage(await loadSession(auth("t"), api(new ApiError(401, "account_deleted", "x"))))).toBe("/entrar");
  });

  it("conta pronta fica na página; carregando também (sem piscar para /entrar)", async () => {
    expect(redirectForAccountPage(await loadSession(auth("t"), api(ready.status === "ready" ? ready.me : null)))).toBeNull();
    expect(redirectForAccountPage({ status: "loading" })).toBeNull();
  });

  it("outro erro da API sobe (a tela mostra a falha, não manda para o login)", async () => {
    await expect(loadSession(auth("t"), api(new ApiError(500, "internal_error", "x")))).rejects.toThrow();
  });

  it("quem já tem conta e abre entrar, criar conta ou cadastro vai para o início", () => {
    for (const page of ["/entrar", "/criar-conta", "/cadastro", "/sem-convite"]) expect(redirectForAuthPage(ready, page)).toBe("/");
    expect(redirectForAuthPage(ready, "/termos")).toBeNull();
    expect(redirectForAuthPage({ status: "unregistered" }, "/sem-convite")).toBe("/cadastro");
    expect(redirectForAuthPage({ status: "signed_out" }, "/entrar")).toBeNull();
  });
});
