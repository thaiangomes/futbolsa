import "reflect-metadata";
import { Controller, Get, Post } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminOnly } from "../../src/infra/auth-adapter/index.js";
import { FixedClock } from "../../src/infra/clock/index.js";
import { createAccount } from "../support/accounts.js";
import { expectAdminOnly } from "../support/admin-routes.js";
import { createTestApp } from "../support/app.js";
import { bearer, TOKEN_T0, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";

/** Rotas de mentira: uma protegida e uma esquecida sem o guard, para testar o ajudante. */
@AdminOnly()
@Controller("admin/ajudante-protegida")
class ProtectedProbe {
  @Get()
  read() {
    return { ok: true };
  }
  @Post()
  create() {
    return { ok: true };
  }
}

@Controller("admin/ajudante-esquecida")
class ForgottenProbe {
  @Get()
  read() {
    return { ok: true };
  }
}

describe("acesso do admin", () => {
  const database = useTestDatabase(5);
  const clock = new FixedClock(new Date(TOKEN_T0.getTime() + 60_000));
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createTestApp({
      db: database.db,
      clock,
      override: withTestAuth(clock),
      controllers: [ProtectedProbe, ForgottenProbe],
    });
  });
  afterAll(() => app.close());

  it("admin 31: jogador comum recebe 403 admin_required em GET /admin/log", async () => {
    const player = await createAccount(database.db);
    const res = await app.inject({ method: "GET", url: "/admin/log", headers: bearer(player.token) });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "admin_required" });
  });

  it("admin 31: GET /admin/log sem login recebe 401, e o admin recebe 200 com a lista", async () => {
    const anonymous = await app.inject({ method: "GET", url: "/admin/log" });
    expect(anonymous.statusCode).toBe(401);
    const admin = await createAccount(database.db, { role: "admin" });
    const res = await app.inject({ method: "GET", url: "/admin/log", headers: bearer(admin.token) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ entries: [], page: 1, pageSize: 50, total: 0 });
  });

  it("admin 31: admin que perdeu o papel perde o acesso na chamada seguinte, com o mesmo token; bloqueado não passa", async () => {
    await expectAdminOnly(app, database.db, { method: "GET", url: "/admin/log" }, { okStatus: 200 });
  });

  it("GET /admin/log valida a consulta: página fora do limite é 400", async () => {
    const admin = await createAccount(database.db, { role: "admin" });
    const res = await app.inject({ method: "GET", url: "/admin/log?pageSize=500", headers: bearer(admin.token) });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "invalid_input", fields: ["pageSize"] });
  });

  it("o ajudante expectAdminOnly passa numa rota protegida, para GET e POST", async () => {
    await expectAdminOnly(app, database.db, { method: "GET", url: "/admin/ajudante-protegida" }, { okStatus: 200 });
    await expectAdminOnly(app, database.db, { method: "POST", url: "/admin/ajudante-protegida" }, { okStatus: 201 });
  });

  it("o ajudante expectAdminOnly falha numa rota de admin esquecida sem o guard", async () => {
    await expect(expectAdminOnly(app, database.db, { method: "GET", url: "/admin/ajudante-esquecida" })).rejects.toThrow();
  });
});
