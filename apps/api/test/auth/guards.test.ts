import "reflect-metadata";
import { Controller, Delete, Get, Patch, Post } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AdminOnly,
  AllowUnregistered,
  CurrentAuth,
  CurrentUser,
  Public,
  type RequestAuth,
  type ResolvedUser,
} from "../../src/infra/auth-adapter/index.js";
import { FixedClock } from "../../src/infra/clock/index.js";
import { RateLimit } from "../../src/infra/http/index.js";
import { authIdentities, users } from "../../src/infra/db/schema/index.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { bearer, TOKEN_T0, tokenFor, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";

@Controller("probe-auth")
class AuthProbeController {
  @Get("me")
  me(@CurrentUser() user: ResolvedUser) {
    return user;
  }

  @Public()
  @Get("public")
  publicRoute(@CurrentAuth() auth: RequestAuth | undefined) {
    return { userId: auth?.user?.id ?? null };
  }

  @AllowUnregistered()
  @Get("unregistered")
  unregistered(@CurrentAuth() auth: RequestAuth) {
    return { userId: auth.user?.id ?? null, email: auth.identity.email };
  }

  @RateLimit("signup")
  @Get("limited")
  limited() {
    return { ok: true };
  }
}

@AdminOnly()
@Controller("admin/probe-auth")
class AdminProbeController {
  @Get()
  read() {
    return { ok: true };
  }
  @Post()
  create() {
    return { ok: true };
  }
  @Patch()
  change() {
    return { ok: true };
  }
  @Delete()
  remove() {
    return { ok: true };
  }
}

const ADMIN_METHODS = ["GET", "POST", "PATCH", "DELETE"] as const;

describe("guards de login e de admin", () => {
  const database = useTestDatabase(10);
  const clock = new FixedClock(new Date(TOKEN_T0.getTime() + 60_000));
  let app: NestFastifyApplication;
  let ana: TestAccount;
  let bruno: TestAccount;
  let admin: TestAccount;

  const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: "GET", url, headers });

  beforeAll(async () => {
    app = await createTestApp({
      db: database.db,
      clock,
      controllers: [AuthProbeController, AdminProbeController],
      override: withTestAuth(clock),
    });
    ana = await createAccount(database.db, { nickname: "anagol" });
    bruno = await createAccount(database.db, { nickname: "bruno_9" });
    admin = await createAccount(database.db, { nickname: "thaian", role: "admin" });
  });
  afterAll(() => app?.close());

  describe("acesso sem token", () => {
    it("rota comum e rota de admin respondem 401 invalid_token", async () => {
      for (const url of ["/probe-auth/me", "/admin/probe-auth"]) {
        const res = await get(url);
        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({ code: "invalid_token", message: expect.any(String) });
      }
    });

    it("cabeçalho malformado responde 401", async () => {
      for (const authorization of ["Bearer", "Bearer ", "Basic dXNlcjpzZW5oYQ==", ana.token, `Token ${ana.token}`]) {
        expect((await get("/probe-auth/me", { authorization })).statusCode).toBe(401);
      }
    });

    it("o token na URL ou em cookie é ignorado", async () => {
      expect((await get(`/probe-auth/me?token=${ana.token}`)).statusCode).toBe(401);
      expect((await get(`/probe-auth/me?access_token=${ana.token}`)).statusCode).toBe(401);
      expect((await get("/probe-auth/me", { cookie: `sb-access-token=${ana.token}` })).statusCode).toBe(401);
    });

    it("rota pública responde sem token", async () => {
      const res = await get("/probe-auth/public");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ userId: null });
    });
  });

  describe("token de outro usuário", () => {
    it("com o token de Bruno, a rota devolve Bruno e nada de Ana", async () => {
      const res = await get("/probe-auth/me", bearer(bruno.token));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ id: bruno.id, role: "player", status: "active" });
      expect(res.body).not.toContain(ana.id);
    });

    it("trocar o sub de um token de Ana pelo de Bruno, sem assinar de novo, dá 401", async () => {
      const [header, payload, signature] = ana.token.split(".");
      const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
      claims.sub = bruno.subject;
      const forged = `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}`;
      expect((await get("/probe-auth/me", bearer(forged))).statusCode).toBe(401);
    });

    it("token vencido ou de outra chave dá 401", async () => {
      const expired = await ana.tokenWith({ at: new Date(TOKEN_T0.getTime() - 3 * 3600_000) });
      expect((await get("/probe-auth/me", bearer(expired))).statusCode).toBe(401);
    });
  });

  describe("jogador comum em rota de admin", () => {
    it("admin 31: jogador comum recebe 403 admin_required em GET, POST, PATCH e DELETE", async () => {
      for (const method of ADMIN_METHODS) {
        const res = await app.inject({ method, url: "/admin/probe-auth", headers: bearer(ana.token) });
        expect(res.statusCode, method).toBe(403);
        expect(res.json().code).toBe("admin_required");
      }
    });

    it("admin passa em todos os métodos", async () => {
      for (const method of ADMIN_METHODS) {
        const res = await app.inject({ method, url: "/admin/probe-auth", headers: bearer(admin.token) });
        expect(res.statusCode, method).toBeLessThan(300);
      }
    });

    it("admin que perdeu o papel recebe 403 na chamada seguinte, com o mesmo token", async () => {
      const ex = await createAccount(database.db, { role: "admin" });
      expect((await get("/admin/probe-auth", bearer(ex.token))).statusCode).toBe(200);
      await database.db.update(users).set({ role: "player" }).where(eq(users.id, ex.id));
      expect((await get("/admin/probe-auth", bearer(ex.token))).statusCode).toBe(403);
    });

    it("jogador promovido a admin passa na chamada seguinte, com o mesmo token", async () => {
      const novo = await createAccount(database.db);
      expect((await get("/admin/probe-auth", bearer(novo.token))).statusCode).toBe(403);
      await database.db.update(users).set({ role: "admin" }).where(eq(users.id, novo.id));
      expect((await get("/admin/probe-auth", bearer(novo.token))).statusCode).toBe(200);
    });

    it("admin bloqueado recebe 403 nas rotas de admin", async () => {
      const blocked = await createAccount(database.db, { role: "admin", status: "blocked" });
      expect((await get("/admin/probe-auth", bearer(blocked.token))).statusCode).toBe(403);
    });
  });

  describe("situação da conta", () => {
    it("conta excluída recebe 401 account_deleted com um token ainda válido", async () => {
      const davi = await createAccount(database.db, { status: "deleted" });
      const res = await get("/probe-auth/me", bearer(davi.token));
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe("account_deleted");
      // e nem as rotas de quem ainda não tem conta servem para ela
      expect((await get("/probe-auth/unregistered", bearer(davi.token))).statusCode).toBe(401);
      // numa rota pública, segue como visitante
      expect((await get("/probe-auth/public", bearer(davi.token))).json()).toEqual({ userId: null });
    });

    it("bloqueado passa no login (lê a própria carteira) e recebe 403 numa rota de admin", async () => {
      const carla = await createAccount(database.db, { status: "blocked" });
      const res = await get("/probe-auth/me", bearer(carla.token));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ id: carla.id, role: "player", status: "blocked" });
      expect((await get("/admin/probe-auth", bearer(carla.token))).statusCode).toBe(403);
    });

    it("logado sem conta: 403 registration_required numa rota comum; as rotas do cadastro passam", async () => {
      const token = await tokenFor({ subject: "e7c2a1d4-0000-4000-8000-000000000001", email: "nova@exemplo.com" });
      const res = await get("/probe-auth/me", bearer(token));
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe("registration_required");
      const reg = await get("/probe-auth/unregistered", bearer(token));
      expect(reg.statusCode).toBe(200);
      expect(reg.json()).toEqual({ userId: null, email: "nova@exemplo.com" });
    });

    it("rota pública com token válido recebe o usuário", async () => {
      expect((await get("/probe-auth/public", bearer(ana.token))).json()).toEqual({ userId: ana.id });
      // token inválido numa rota pública: segue como visitante, sem erro
      expect((await get("/probe-auth/public", bearer("lixo"))).json()).toEqual({ userId: null });
    });
  });

  describe("conta 3: mesmo e-mail, mesma conta", () => {
    it("identidade nova com o mesmo e-mail confirmado, em outras maiúsculas, cai no mesmo usuário", async () => {
      const ana2 = await createAccount(database.db, { nickname: "ana_google", email: "ana.souza@exemplo.com" });
      const novaIdentidade = "b1d0c3a2-1111-4111-8111-000000000003";
      const token = await tokenFor({ subject: novaIdentidade, email: "Ana.Souza@Exemplo.COM" });
      const res = await get("/probe-auth/me", bearer(token));
      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe(ana2.id);
      const links = await database.db.select().from(authIdentities).where(eq(authIdentities.userId, ana2.id));
      expect(links.map((l) => l.subject).sort()).toEqual([ana2.subject, novaIdentidade].sort());
    });

    it("duas chamadas ao mesmo tempo com a identidade nova ligam uma vez só", async () => {
      const bia = await createAccount(database.db, { email: "bia@exemplo.com" });
      const token = await tokenFor({ subject: "b1d0c3a2-1111-4111-8111-000000000004", email: "bia@exemplo.com" });
      const results = await Promise.all(Array.from({ length: 8 }, () => get("/probe-auth/me", bearer(token))));
      for (const r of results) expect(r.json().id).toBe(bia.id);
      const links = await database.db.select().from(authIdentities).where(eq(authIdentities.userId, bia.id));
      expect(links).toHaveLength(2);
    });

    it("conta 5: e-mail não confirmado recebe 403 email_not_confirmed e não liga a conta de ninguém", async () => {
      const subject = "b1d0c3a2-1111-4111-8111-000000000005";
      const token = await tokenFor({ subject, email: ana.email, emailVerified: false });
      const res = await get("/probe-auth/me", bearer(token));
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe("email_not_confirmed");
      expect((await get("/probe-auth/unregistered", bearer(token))).statusCode).toBe(403);
      const links = await database.db.select().from(authIdentities).where(eq(authIdentities.subject, subject));
      expect(links).toHaveLength(0);
    });

    it("identidade nova com o e-mail de uma conta excluída não liga a ela", async () => {
      const subject = "b1d0c3a2-1111-4111-8111-000000000006";
      await createAccount(database.db, { status: "deleted" });
      const token = await tokenFor({ subject, email: "ninguem-mais@exemplo.com" });
      expect((await get("/probe-auth/me", bearer(token))).json().code).toBe("registration_required");
    });
  });

  describe("limite de uso por pessoa", () => {
    it("a 11ª chamada de Ana numa rota de 10 por minuto dá 429; Bruno, do mesmo IP, passa", async () => {
      for (let i = 0; i < 10; i++) {
        expect((await get("/probe-auth/limited", bearer(ana.token))).statusCode).toBe(200);
      }
      const blocked = await get("/probe-auth/limited", bearer(ana.token));
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().code).toBe("too_many_requests");
      expect((await get("/probe-auth/limited", bearer(bruno.token))).statusCode).toBe(200);
    });
  });
});
