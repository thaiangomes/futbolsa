import "reflect-metadata";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../../src/infra/clock/index.js";
import { adminLog, users } from "../../src/infra/db/schema/index.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { bearer, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";

describe("papéis", () => {
  const database = useTestDatabase(10);
  const clock = new FixedClock(new Date("2027-03-20T12:00:00Z"));
  let app: NestFastifyApplication;

  const setRole = async (actor: TestAccount, target: string, role: string, reason?: string) =>
    app.inject({
      method: "PATCH",
      url: `/admin/players/${target}/role`,
      headers: bearer(await actor.tokenWith({ at: clock.now() })),
      payload: reason === undefined ? { role } : { role, reason },
    });
  const roleOf = async (id: string) => (await database.db.select().from(users).where(eq(users.id, id)))[0]!.role;

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
  });
  afterAll(() => app?.close());
  // cada teste começa sem nenhum admin; ele cria os seus
  beforeEach(async () => {
    await database.db.update(users).set({ role: "player" }).where(eq(users.role, "admin"));
  });

  it("admin 31: sem token 401; jogador comum 403", async () => {
    const ana = await createAccount(database.db);
    const target = await createAccount(database.db);
    const anon = await app.inject({ method: "PATCH", url: `/admin/players/${target.id}/role`, payload: { role: "admin", reason: "teste" } });
    expect(anon.statusCode).toBe(401);
    const res = await setRole(ana, target.id, "admin", "quero ser admin");
    expect(res.statusCode).toBe(403);
    expect(await roleOf(target.id)).toBe("player");
  });

  it("admin 32: o único admin tirando o próprio papel recebe last_admin", async () => {
    const thaian = await createAccount(database.db, { role: "admin" });
    const res = await setRole(thaian, thaian.id, "player", "sair do admin");
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("last_admin");
    expect(await roleOf(thaian.id)).toBe("admin");
  });

  it("com dois admins, um tira o papel do outro; o promovido entra no admin na chamada seguinte", async () => {
    const thaian = await createAccount(database.db, { role: "admin" });
    const bia = await createAccount(database.db);
    const biaToken = await bia.tokenWith({ at: clock.now() });
    expect((await app.inject({ method: "GET", url: "/admin/invites", headers: bearer(biaToken) })).statusCode).toBe(403);
    expect((await setRole(thaian, bia.id, "admin", "ajuda no admin")).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/admin/invites", headers: bearer(biaToken) })).statusCode).toBe(200);
    expect((await setRole(bia, thaian.id, "player", "troca de turno")).statusCode).toBe(204);
    const thaianToken = await thaian.tokenWith({ at: clock.now() });
    expect((await app.inject({ method: "GET", url: "/admin/invites", headers: bearer(thaianToken) })).statusCode).toBe(403);
  });

  it("admin 32: dois admins tirando o papel um do outro ao mesmo tempo: um passa, o outro recebe last_admin", async () => {
    for (let i = 0; i < 5; i++) {
      await database.db.update(users).set({ role: "player" }).where(eq(users.role, "admin"));
      const a = await createAccount(database.db, { role: "admin" });
      const b = await createAccount(database.db, { role: "admin" });
      const results = await Promise.all([setRole(a, b.id, "player", "corrida"), setRole(b, a.id, "player", "corrida")]);
      // quem perde recebe last_admin (as duas passaram pelo guard) ou admin_required (a outra
      // terminou antes e ela já não é admin); nos dois casos sobra exatamente um admin
      const codes = results.map((r) => r.statusCode).sort();
      expect(codes[0]).toBe(204);
      expect([403, 409]).toContain(codes[1]);
      const admins = await database.db.select().from(users).where(eq(users.role, "admin"));
      expect(admins).toHaveLength(1);
    }
  });

  it("admin 33: a mudança fica no registro com antes, depois e motivo; sem motivo é recusada", async () => {
    const thaian = await createAccount(database.db, { role: "admin" });
    const caio = await createAccount(database.db);
    const noReason = await setRole(thaian, caio.id, "admin");
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().fields).toEqual(["reason"]);
    expect(await roleOf(caio.id)).toBe("player");

    expect((await setRole(thaian, caio.id, "admin", "vai cuidar dos resultados")).statusCode).toBe(204);
    const [row] = await database.db.select().from(adminLog).where(eq(adminLog.targetId, caio.id));
    expect(row).toMatchObject({
      actorId: thaian.id,
      at: clock.now(),
      action: "player.role",
      targetType: "user",
      before: { role: "player" },
      after: { role: "admin" },
      reason: "vai cuidar dos resultados",
    });
  });

  it("conta bloqueada não vira admin; conta excluída ou id inexistente dão 404; id inválido dá 400", async () => {
    const thaian = await createAccount(database.db, { role: "admin" });
    const blocked = await createAccount(database.db, { status: "blocked" });
    expect((await setRole(thaian, blocked.id, "admin", "promover")).statusCode).toBe(400);
    const deleted = await createAccount(database.db, { status: "deleted" });
    expect((await setRole(thaian, deleted.id, "admin", "promover")).statusCode).toBe(404);
    expect((await setRole(thaian, "6f1c0e2a-0000-4000-8000-000000000000", "admin", "promover")).statusCode).toBe(404);
    expect((await setRole(thaian, "nao-e-uuid", "admin", "promover")).statusCode).toBe(400);
  });

  it("admin 31: admin bloqueado não muda papéis", async () => {
    await createAccount(database.db, { role: "admin" });
    const blockedAdmin = await createAccount(database.db, { role: "admin", status: "blocked" });
    const target = await createAccount(database.db);
    expect((await setRole(blockedAdmin, target.id, "admin", "promover")).statusCode).toBe(403);
  });
});
