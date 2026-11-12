import { meResponseSchema } from "@futbolsa/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ApiClient, ApiError } from "./api";
import type { AuthClient } from "./auth";

/** Login falso: um token atual e, se pedirem, um renovado. */
function fakeAuth(tokens: { current: string | null; refreshed?: string | null }) {
  const calls: Array<{ forceRefresh?: boolean }> = [];
  const auth = {
    getAccessToken: async (options: { forceRefresh?: boolean } = {}) => {
      calls.push(options);
      return options.forceRefresh ? (tokens.refreshed ?? null) : tokens.current;
    },
  } as unknown as AuthClient;
  return { auth, calls };
}

/** Uma API falsa que guarda as chamadas e responde na ordem. */
function fakeFetch(responses: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift()!;
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const me = { registered: false, invited: true };

describe("cliente da API", () => {
  it("o token vai só no cabeçalho Authorization, nunca na URL", async () => {
    const { auth } = fakeAuth({ current: "tok.en.abc" });
    const { fetchFn, calls } = fakeFetch([{ status: 200, body: me }]);
    const api = new ApiClient({ baseUrl: "http://api.local/", auth, fetch: fetchFn });
    expect(await api.request(meResponseSchema, "/me")).toEqual(me);
    expect(calls[0]!.url).toBe("http://api.local/me");
    expect(calls[0]!.url).not.toContain("tok.en.abc");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok.en.abc");
  });

  it("sem sessão, a chamada vai sem Authorization", async () => {
    const { auth } = fakeAuth({ current: null });
    const { fetchFn, calls } = fakeFetch([{ status: 200, body: { nickname: "anagol" } }]);
    await new ApiClient({ baseUrl: "http://api.local", auth, fetch: fetchFn }).request(z.object({ nickname: z.string() }), "/players/anagol");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("corpo vai em JSON; erro da API vira ApiError com código, mensagem e campos", async () => {
    const { auth } = fakeAuth({ current: "t" });
    const { fetchFn, calls } = fakeFetch([{ status: 409, body: { code: "nickname_taken", message: "Este apelido já está em uso." } }]);
    const api = new ApiClient({ baseUrl: "http://api.local", auth, fetch: fetchFn });
    const error = await api.request(meResponseSchema, "/me", { method: "POST", body: { nickname: "anagol", acceptTerms: true } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: "nickname_taken", message: "Este apelido já está em uso." });
    expect(calls[0]!.init.body).toBe(JSON.stringify({ nickname: "anagol", acceptTerms: true }));
    expect((calls[0]!.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("o resto do corpo do erro (a prévia do correction_stale) fica em extra", async () => {
    const { auth } = fakeAuth({ current: "t" });
    const body = { code: "correction_stale", message: "Mudou.", preview: { planCode: "b" } };
    const { fetchFn } = fakeFetch([{ status: 409, body }]);
    const api = new ApiClient({ baseUrl: "http://api.local", auth, fetch: fetchFn });
    const error = await api.request(meResponseSchema, "/me").catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 409, code: "correction_stale", extra: { preview: { planCode: "b" } } });
  });

  it("401 invalid_token renova a sessão uma vez e repete com o token novo", async () => {
    const { auth, calls: tokenCalls } = fakeAuth({ current: "velho", refreshed: "novo" });
    const { fetchFn, calls } = fakeFetch([
      { status: 401, body: { code: "invalid_token", message: "x" } },
      { status: 200, body: me },
    ]);
    const api = new ApiClient({ baseUrl: "http://api.local", auth, fetch: fetchFn });
    expect(await api.request(meResponseSchema, "/me")).toEqual(me);
    expect(tokenCalls).toEqual([{}, { forceRefresh: true }]);
    expect((calls[1]!.init.headers as Record<string, string>).authorization).toBe("Bearer novo");
  });

  it("se o token renovado também falhar, o erro sobe (a porta manda para /entrar)", async () => {
    const { auth } = fakeAuth({ current: "velho", refreshed: "novo" });
    const { fetchFn, calls } = fakeFetch([
      { status: 401, body: { code: "invalid_token", message: "x" } },
      { status: 401, body: { code: "invalid_token", message: "x" } },
    ]);
    const error = await new ApiClient({ baseUrl: "http://api.local", auth, fetch: fetchFn }).request(meResponseSchema, "/me").catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "invalid_token" });
    expect(calls).toHaveLength(2);
  });

  it("401 de conta excluída não tenta renovar", async () => {
    const { auth, calls: tokenCalls } = fakeAuth({ current: "t", refreshed: "n" });
    const { fetchFn } = fakeFetch([{ status: 401, body: { code: "account_deleted", message: "x" } }]);
    await new ApiClient({ baseUrl: "http://api.local", auth, fetch: fetchFn }).request(meResponseSchema, "/me").catch(() => undefined);
    expect(tokenCalls).toEqual([{}]);
  });

  it("resposta fora do contrato é recusada; resposta sem corpo JSON vira internal_error", async () => {
    const { auth } = fakeAuth({ current: "t" });
    const a = fakeFetch([{ status: 200, body: { registered: false, invited: true, email: "outra@exemplo.com" } }]);
    await expect(new ApiClient({ baseUrl: "http://api.local", auth, fetch: a.fetchFn }).request(meResponseSchema, "/me")).rejects.toThrow();
    const b = fakeFetch([{ status: 502 }]);
    await expect(new ApiClient({ baseUrl: "http://api.local", auth, fetch: b.fetchFn }).request(meResponseSchema, "/me")).rejects.toMatchObject({ code: "internal_error" });
  });
});
