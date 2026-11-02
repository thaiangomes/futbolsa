import "reflect-metadata";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixedClock } from "../../src/infra/clock/index.js";
import { users } from "../../src/infra/db/schema/index.js";
import { createAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { bearer, TOKEN_T0, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";

describe("troca de apelido e perfil público", () => {
  const database = useTestDatabase(10);
  const clock = new FixedClock(new Date(TOKEN_T0.getTime() + 60_000));
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
  });
  afterAll(() => app?.close());

  const patch = (token: string, nickname: unknown) =>
    app.inject({ method: "PATCH", url: "/me/nickname", headers: bearer(token), payload: { nickname } });
  const profile = (nickname: string, headers: Record<string, string> = {}) =>
    app.inject({ method: "GET", url: `/players/${encodeURIComponent(nickname)}`, headers });

  it("conta 10: Ana troca anagol por ana_fla; o perfil acha ana_fla, anagol some e fica livre", async () => {
    const ana = await createAccount(database.db, { nickname: "anagol" });
    expect((await patch(ana.token, "ana_fla")).statusCode).toBe(204);
    expect((await profile("ana_fla")).json()).toEqual({ nickname: "ana_fla" });
    expect((await profile("anagol")).statusCode).toBe(404);
    const outro = await createAccount(database.db);
    expect((await patch(outro.token, "anagol")).statusCode).toBe(204);
  });

  it("conta 8: apelido em uso por outra pessoa, em outras maiúsculas, recebe nickname_taken", async () => {
    await createAccount(database.db, { nickname: "flamengo_10" });
    const bruno = await createAccount(database.db);
    const res = await patch(bruno.token, "Flamengo_10");
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("nickname_taken");
  });

  it("conta 9 e 25 na troca: inválidos e reservados são recusados", async () => {
    const carla = await createAccount(database.db);
    for (const n of ["ab", "um_apelido_com_mais_de_20", "joão"]) expect((await patch(carla.token, n)).json().code).toBe("invalid_input");
    for (const n of ["Casa", "ADMIN", "conta_excluida"]) expect((await patch(carla.token, n)).json().code).toBe("nickname_reserved");
  });

  it("a própria pessoa troca só as maiúsculas do apelido", async () => {
    const ana = await createAccount(database.db, { nickname: "mudacaixa" });
    expect((await patch(ana.token, "MudaCaixa")).statusCode).toBe(204);
    const [row] = await database.db.select().from(users).where(eq(users.id, ana.id));
    expect(row!.nickname).toBe("MudaCaixa");
  });

  it("conta 11: o perfil público, sem login, mostra só o apelido; a busca não diferencia maiúsculas", async () => {
    const davi = await createAccount(database.db, { nickname: "davi_perfil" });
    const res = await profile("DAVI_PERFIL");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ nickname: "davi_perfil" });
    expect(res.body).not.toContain(davi.email);
    expect(res.body).not.toContain(davi.id);
  });

  it("conta excluída não tem perfil; apelido inválido na URL dá 400", async () => {
    await createAccount(database.db, { nickname: "excluido_x", status: "deleted" });
    expect((await profile("excluido_x")).statusCode).toBe(404);
    expect((await profile("a")).statusCode).toBe(400);
  });

  it("sem token, PATCH /me/nickname dá 401; com o token de Bruno, só o apelido de Bruno muda", async () => {
    expect((await app.inject({ method: "PATCH", url: "/me/nickname", payload: { nickname: "qualquer" } })).statusCode).toBe(401);
    const ana = await createAccount(database.db, { nickname: "ana_intacta" });
    const bruno = await createAccount(database.db, { nickname: "bruno_antes" });
    expect((await patch(bruno.token, "bruno_depois")).statusCode).toBe(204);
    const [a] = await database.db.select().from(users).where(eq(users.id, ana.id));
    expect(a!.nickname).toBe("ana_intacta");
  });

  it("o bloqueado também troca o próprio apelido", async () => {
    const b = await createAccount(database.db, { status: "blocked" });
    expect((await patch(b.token, "bloqueado_ok")).statusCode).toBe(204);
  });
});
