import { describe, expect, it } from "vitest";
import { AuthVerifier, InvalidTokenError, type AuthIdentity } from "../../src/infra/auth-adapter/auth-verifier.js";
import { UserResolver, type ResolvedUser } from "../../src/infra/auth-adapter/user-resolver.js";
import { AuthFromAccounts } from "../../src/infra/realtime/auth-from-accounts.js";

const identity = (overrides: Partial<AuthIdentity> = {}): AuthIdentity => ({
  provider: "supabase",
  subject: "sub-1",
  email: "ana@exemplo.com",
  emailVerified: true,
  authenticatedAt: new Date("2027-04-01T13:00:00Z"),
  expiresAt: new Date("2027-04-01T14:00:00Z"),
  ...overrides,
});

class StubVerifier extends AuthVerifier {
  calls: string[] = [];
  constructor(private readonly result: AuthIdentity | Error) {
    super();
  }
  async verify(token: string): Promise<AuthIdentity> {
    this.calls.push(token);
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
  async deleteIdentity(): Promise<void> {}
}

class StubResolver extends UserResolver {
  calls = 0;
  constructor(private readonly user: ResolvedUser | null) {
    super();
  }
  async resolve(): Promise<ResolvedUser | null> {
    this.calls++;
    return this.user;
  }
}

function make(who: AuthIdentity | Error, user: ResolvedUser | null) {
  const verifier = new StubVerifier(who);
  const resolver = new StubResolver(user);
  return { auth: new AuthFromAccounts(verifier, resolver), verifier, resolver };
}

describe("autenticador real do tempo real (T12)", () => {
  it("C27: jogador ativo devolve id, papel e status", async () => {
    const { auth, verifier } = make(identity(), { id: "u1", role: "player", status: "active" });
    expect(await auth.authenticate("tok")).toEqual({
      ok: true,
      identity: { userId: "u1", role: "player", status: "active" },
    });
    expect(verifier.calls).toEqual(["tok"]);
  });

  it("C27: jogador bloqueado entra com status blocked (ele lê a própria carteira)", async () => {
    const { auth } = make(identity(), { id: "u2", role: "player", status: "blocked" });
    expect(await auth.authenticate("tok")).toEqual({
      ok: true,
      identity: { userId: "u2", role: "player", status: "blocked" },
    });
  });

  it("C27: admin devolve o papel admin", async () => {
    const { auth } = make(identity(), { id: "u3", role: "admin", status: "active" });
    expect(await auth.authenticate("tok")).toEqual({
      ok: true,
      identity: { userId: "u3", role: "admin", status: "active" },
    });
  });

  it("C27: identidade sem conta do jogo dá no_account", async () => {
    const { auth } = make(identity(), null);
    expect(await auth.authenticate("tok")).toEqual({ ok: false, code: "no_account" });
  });

  it("C27: conta excluída dá account_deleted", async () => {
    const { auth } = make(identity(), { id: "u4", role: "player", status: "deleted" });
    expect(await auth.authenticate("tok")).toEqual({ ok: false, code: "account_deleted" });
  });

  it("C27: token inválido dá invalid_token, sem consultar as contas", async () => {
    const { auth, resolver } = make(new InvalidTokenError("expirado"), null);
    expect(await auth.authenticate("lixo")).toEqual({ ok: false, code: "invalid_token" });
    expect(resolver.calls).toBe(0);
  });

  it("C27: e-mail sem confirmação não entra (no_account) e nem consulta as contas", async () => {
    const { auth, resolver } = make(identity({ emailVerified: false }), { id: "u5", role: "player", status: "active" });
    expect(await auth.authenticate("tok")).toEqual({ ok: false, code: "no_account" });
    expect(resolver.calls).toBe(0);
  });

  it("falha inesperada na consulta não vira token inválido: sobe o erro (a sessão derruba a conexão)", async () => {
    const verifier = new StubVerifier(identity());
    const resolver = new StubResolver(null);
    resolver.resolve = async () => {
      throw new Error("banco fora do ar");
    };
    await expect(new AuthFromAccounts(verifier, resolver).authenticate("tok")).rejects.toThrow("banco fora do ar");
  });
});
