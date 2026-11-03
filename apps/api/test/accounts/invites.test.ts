import "reflect-metadata";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthVerifier } from "../../src/infra/auth-adapter/index.js";
import { FixedClock } from "../../src/infra/clock/index.js";
import { adminLog, invites } from "../../src/infra/db/schema/index.js";
import { AccountsConfig, emailFingerprint } from "../../src/modules/accounts/index.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { bearer, testVerifier, tokenFor } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";

const KEY = "chave-de-teste-do-registro";

describe("convites do admin", () => {
  const database = useTestDatabase(10);
  const clock = new FixedClock(new Date("2027-03-20T12:00:00Z"));
  let app: NestFastifyApplication;
  let admin: TestAccount;
  let player: TestAccount;
  let adminToken: string;

  const call = (method: "GET" | "POST" | "DELETE", url: string, token?: string, payload?: object) =>
    app.inject({ method, url, headers: token ? bearer(token) : {}, payload });

  beforeAll(async () => {
    app = await createTestApp({
      db: database.db,
      clock,
      override: (b) =>
        b
          .overrideProvider(AuthVerifier)
          .useValue(testVerifier(clock))
          .overrideProvider(AccountsConfig)
          .useValue({ bootstrapAdminEmail: null, adminLogEmailKey: KEY }),
    });
    admin = await createAccount(database.db, { role: "admin" });
    player = await createAccount(database.db);
    adminToken = await admin.tokenWith({ at: clock.now() });
  });
  afterAll(() => app?.close());

  it("admin 31: sem token 401; jogador comum 403 nas três rotas", async () => {
    const playerToken = await player.tokenWith({ at: clock.now() });
    const routes = [
      ["GET", "/admin/invites"],
      ["POST", "/admin/invites"],
      ["DELETE", "/admin/invites/ana@exemplo.com"],
    ] as const;
    for (const [method, url] of routes) {
      expect((await call(method, url, undefined, { emails: ["x@exemplo.com"] })).statusCode, `${method} sem token`).toBe(401);
      const res = await call(method, url, playerToken, { emails: ["x@exemplo.com"] });
      expect(res.statusCode, `${method} jogador`).toBe(403);
      expect(res.json().code).toBe("admin_required");
    }
    expect(await database.db.select().from(invites).where(eq(invites.email, "x@exemplo.com"))).toHaveLength(0);
  });

  it("conta 1: liberado Ana@Exemplo.com, Ana se cadastra com ana@exemplo.com", async () => {
    const res = await call("POST", "/admin/invites", adminToken, { emails: ["Ana@Exemplo.com"] });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ invited: ["ana@exemplo.com"], alreadyInvited: [], alreadyRegistered: [] });
    const token = await tokenFor({ subject: "aaaaaaaa-0001-4001-8001-000000000001", email: "ana@exemplo.com", at: clock.now() });
    const signup = await app.inject({ method: "POST", url: "/me", headers: bearer(token), payload: { nickname: "ana_conv", acceptTerms: true } });
    expect(signup.statusCode).toBe(201);
    const list = (await call("GET", "/admin/invites", adminToken)).json();
    expect(list.invites).toContainEqual({ email: "ana@exemplo.com", createdAt: clock.now().toISOString(), usedAt: clock.now().toISOString() });
  });

  it("lista: repetidos ignorados, já liberado e e-mail com conta avisados", async () => {
    await createAccount(database.db, { email: "tem.conta@exemplo.com" });
    await call("POST", "/admin/invites", adminToken, { emails: ["ja@exemplo.com"] });
    const res = await call("POST", "/admin/invites", adminToken, {
      emails: ["novo1@exemplo.com", "NOVO1@exemplo.com", "ja@exemplo.com", "Tem.Conta@exemplo.com"],
    });
    expect(res.json()).toEqual({ invited: ["novo1@exemplo.com"], alreadyInvited: ["ja@exemplo.com"], alreadyRegistered: ["tem.conta@exemplo.com"] });
  });

  it("lista de 201 e-mails ou e-mail inválido é recusada, com o item", async () => {
    const many = Array.from({ length: 201 }, (_, i) => `p${i}@exemplo.com`);
    expect((await call("POST", "/admin/invites", adminToken, { emails: many })).statusCode).toBe(400);
    const bad = await call("POST", "/admin/invites", adminToken, { emails: ["ok@exemplo.com", "sem-arroba"] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().fields).toEqual(["emails.1"]);
  });

  it("conta 19: retirado o convite, a pessoa não cria conta; convite usado não sai", async () => {
    await call("POST", "/admin/invites", adminToken, { emails: ["bruno@exemplo.com"] });
    expect((await call("DELETE", "/admin/invites/Bruno@Exemplo.com", adminToken)).statusCode).toBe(204);
    const token = await tokenFor({ subject: "aaaaaaaa-0002-4002-8002-000000000002", email: "bruno@exemplo.com", at: clock.now() });
    const signup = await app.inject({ method: "POST", url: "/me", headers: bearer(token), payload: { nickname: "bruno_19", acceptTerms: true } });
    expect(signup.json().code).toBe("invite_required");

    const used = await call("DELETE", "/admin/invites/ana@exemplo.com", adminToken);
    expect(used.statusCode).toBe(409);
    expect(used.json().code).toBe("invite_used");
    expect((await call("DELETE", "/admin/invites/ninguem@exemplo.com", adminToken)).statusCode).toBe(404);
  });

  it("admin 33: liberar e retirar vão para o registro com autor e hora, e o e-mail embaralhado", async () => {
    await call("POST", "/admin/invites", adminToken, { emails: ["carla@exemplo.com"] });
    await call("DELETE", "/admin/invites/carla@exemplo.com", adminToken);
    const rows = await database.db.select().from(adminLog).where(eq(adminLog.targetId, emailFingerprint(KEY, "carla@exemplo.com")));
    expect(rows.map((r) => r.action)).toEqual(["invite.create", "invite.revoke"]);
    for (const r of rows) {
      expect(r).toMatchObject({ actorId: admin.id, at: clock.now(), targetType: "invite" });
      expect(JSON.stringify(r)).not.toContain("carla@exemplo.com");
    }
  });

  it("conta 23: e-mail de conta excluída sai da lista e pode ser liberado de novo", async () => {
    const davi = await createAccount(database.db, { email: "davi@exemplo.com" });
    await database.db.insert(invites).values({ email: "davi@exemplo.com", usedAt: clock.now() });
    const token = await davi.tokenWith({ at: clock.now() });
    expect((await app.inject({ method: "DELETE", url: "/me", headers: bearer(token), payload: { confirmNickname: davi.nickname } })).statusCode).toBe(202);
    expect((await call("GET", "/admin/invites", adminToken)).json().invites.map((i: { email: string }) => i.email)).not.toContain("davi@exemplo.com");
    expect((await call("POST", "/admin/invites", adminToken, { emails: ["davi@exemplo.com"] })).json().invited).toEqual(["davi@exemplo.com"]);
  });
});
