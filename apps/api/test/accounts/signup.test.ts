import "reflect-metadata";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { meResponseSchema } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { authIdentities, invites, seasons, users, walletEntries, wallets } from "../../src/infra/db/schema/index.js";
import { AccountsConfig } from "../../src/modules/accounts/index.js";
import { createAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { bearer, testVerifier, tokenFor } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { seedSeason } from "../support/fixtures.js";
import { AuthVerifier } from "../../src/infra/auth-adapter/index.js";

const BOOTSTRAP = "thaian@exemplo.com";

describe("cadastro: GET /me e POST /me", () => {
  const database = useTestDatabase(10);
  const clock = new FixedClock(new Date("2027-03-20T12:00:00Z"));
  let app: NestFastifyApplication;
  let seasonId: number;
  let n = 0;

  /** Uma pessoa nova no login (sem conta no jogo), com o token no instante do relógio. */
  async function person(email?: string, options: { emailVerified?: boolean; claims?: Record<string, unknown> } = {}) {
    n++;
    const subject = `0000000${n}-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
    const mail = email ?? `pessoa${n}@exemplo.com`;
    return { subject, email: mail, token: await tokenFor({ subject, email: mail, at: clock.now(), ...options }) };
  }
  const invite = (email: string) => database.db.insert(invites).values({ email: email.toLowerCase(), createdAt: clock.now() });
  const register = (token: string, payload: unknown) =>
    app.inject({ method: "POST", url: "/me", headers: bearer(token), payload: payload as object });
  const setSeason = (values: Partial<typeof seasons.$inferInsert>) =>
    database.db.update(seasons).set(values).where(eq(seasons.id, seasonId));

  beforeAll(async () => {
    ({ seasonId } = await seedSeason(database.db, 2027));
    app = await createTestApp({
      db: database.db,
      clock,
      override: (b) =>
        b
          .overrideProvider(AuthVerifier)
          .useValue(testVerifier(clock))
          .overrideProvider(AccountsConfig)
          .useValue({ bootstrapAdminEmail: BOOTSTRAP }),
    });
  });
  afterAll(() => app?.close());
  beforeEach(async () => {
    clock.set(new Date("2027-03-20T12:00:00Z"));
    await setSeason({ status: "preparing", ipoOpensAt: new Date("2027-03-28T19:00:00Z"), ipoClosesAt: new Date("2027-04-04T19:00:00Z") });
  });

  it("sem token, 401", async () => {
    expect((await app.inject({ method: "GET", url: "/me" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/me", payload: { nickname: "anagol", acceptTerms: true } })).statusCode).toBe(401);
  });

  it("conta 1: e-mail não liberado recebe 403 invite_required e nada é criado", async () => {
    const p = await person("sem.convite@exemplo.com");
    const me = await app.inject({ method: "GET", url: "/me", headers: bearer(p.token) });
    expect(me.json()).toEqual({ registered: false, invited: false });
    const res = await register(p.token, { nickname: "semconvite", acceptTerms: true });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("invite_required");
    expect(await database.db.select().from(users).where(eq(users.email, p.email))).toHaveLength(0);
    expect(await database.db.select().from(authIdentities).where(eq(authIdentities.subject, p.subject))).toHaveLength(0);
  });

  it("conta 1: com o Google também (mesma regra para qualquer jeito de entrar)", async () => {
    const p = await person("google.sem.convite@exemplo.com", {
      claims: { app_metadata: { provider: "google", providers: ["google"] }, user_metadata: { email_verified: true } },
    });
    expect((await register(p.token, { nickname: "googlesem", acceptTerms: true })).json().code).toBe("invite_required");
  });

  it("conta 2: sem apelido ou sem o aceite, nada é criado; com os dois, a conta nasce com a data do aceite", async () => {
    const p = await person("ana@exemplo.com");
    await invite(p.email);
    expect((await app.inject({ method: "GET", url: "/me", headers: bearer(p.token) })).json()).toEqual({ registered: false, invited: true });
    expect((await register(p.token, { acceptTerms: true })).statusCode).toBe(400);
    expect((await register(p.token, { nickname: "anagol" })).statusCode).toBe(400);
    expect((await register(p.token, { nickname: "anagol", acceptTerms: false })).statusCode).toBe(400);
    expect(await database.db.select().from(users).where(eq(users.email, p.email))).toHaveLength(0);

    const res = await register(p.token, { nickname: "anagol", acceptTerms: true });
    expect(res.statusCode).toBe(201);
    const body = meResponseSchema.parse(res.json());
    expect(body).toMatchObject({ registered: true, nickname: "anagol", email: "ana@exemplo.com", role: "player", status: "active" });
    expect(body.registered && body.termsAcceptedAt).toBe("2027-03-20T12:00:00.000Z");
    const [inv] = await database.db.select().from(invites).where(eq(invites.email, p.email));
    expect(inv!.usedAt).toEqual(clock.now());
  });

  it("conta 8: com anagol em uso, AnaGol recebe 409 nickname_taken", async () => {
    await createAccount(database.db, { nickname: "anagol8" });
    const p = await person();
    await invite(p.email);
    const res = await register(p.token, { nickname: "AnaGol8", acceptTerms: true });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("nickname_taken");
  });

  it("conta 9 e 25: apelidos inválidos e reservados pela rota", async () => {
    const p = await person();
    await invite(p.email);
    for (const nickname of ["ab", "um_apelido_com_mais_de_20", "joão"]) {
      expect((await register(p.token, { nickname, acceptTerms: true })).json().code).toBe("invalid_input");
    }
    for (const nickname of ["Casa", "ADMIN", "conta_excluida"]) {
      const res = await register(p.token, { nickname, acceptTerms: true });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("nickname_reserved");
    }
    expect((await register(p.token, { nickname: "joao_10", acceptTerms: true })).statusCode).toBe(201);
  });

  it("conta 12: conta criada antes do IPO fica sem carteira e vê a data de abertura", async () => {
    const p = await person();
    await invite(p.email);
    await register(p.token, { nickname: "ana_12", acceptTerms: true });
    clock.set(new Date("2027-03-25T12:00:00Z"));
    const token = await tokenFor({ subject: p.subject, email: p.email, at: clock.now() });
    const me = (await app.inject({ method: "GET", url: "/me", headers: bearer(token) })).json();
    expect(me.season).toEqual({ year: 2027, status: "preparing", ipoOpensAt: "2027-03-28T19:00:00.000Z", hasWallet: false, needsEntry: false });
  });

  it("conta 13: com as ofertas do IPO abertas, a conta nasce com R$ 100.000,00", async () => {
    await setSeason({ status: "ipo_open" });
    const p = await person();
    await invite(p.email);
    const res = await register(p.token, { nickname: "bruno_13", acceptTerms: true });
    expect(res.json().season).toMatchObject({ status: "ipo_open", hasWallet: true, needsEntry: false });
    const [user] = await database.db.select().from(users).where(eq(users.email, p.email));
    const [wallet] = await database.db.select().from(wallets).where(eq(wallets.userId, user!.id));
    expect(wallet).toMatchObject({ cash: 10_000_000, reservedCash: 0, entryMode: "ipo", seasonId });
    const entries = await database.db.select().from(walletEntries).where(eq(walletEntries.walletId, wallet!.id));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "initial", cashDelta: 10_000_000, cashAfter: 10_000_000 });
  });

  it("conta 14: depois do fechamento do IPO, não recebe R$ 100.000,00 e vai para a entrada no meio", async () => {
    await setSeason({ status: "trading" });
    clock.set(new Date("2027-06-15T12:00:00Z"));
    const p = await person();
    await invite(p.email);
    const res = await register(p.token, { nickname: "carla_14", acceptTerms: true });
    expect(res.json().season).toMatchObject({ status: "trading", hasWallet: false, needsEntry: true });
    const [user] = await database.db.select().from(users).where(eq(users.email, p.email));
    expect(await database.db.select().from(wallets).where(eq(wallets.userId, user!.id))).toHaveLength(0);
  });

  it("conta 20: o jogo guarda só e-mail, apelido e a data do aceite, sem nome nem foto", async () => {
    const p = await person("ana.google@exemplo.com", {
      claims: {
        app_metadata: { provider: "google", providers: ["google"] },
        user_metadata: { email_verified: true, full_name: "Ana Souza Lima", avatar_url: "https://lh3.foto/ana.png" },
      },
    });
    await invite(p.email);
    expect((await register(p.token, { nickname: "ana_20", acceptTerms: true })).statusCode).toBe(201);
    const found = await database.db.execute(sql`
      select table_name, column_name from information_schema.columns
      where table_schema = 'futbolsa' and data_type in ('text', 'jsonb', 'character varying')`);
    for (const { table_name, column_name } of found.rows as Array<{ table_name: string; column_name: string }>) {
      const hit = await database.db.execute(
        sql`select 1 from ${sql.identifier("futbolsa")}.${sql.identifier(table_name)}
            where ${sql.identifier(column_name)}::text ilike ${"%Souza%"} or ${sql.identifier(column_name)}::text ilike ${"%foto/ana%"} limit 1`,
      );
      expect(hit.rows, `${table_name}.${column_name}`).toHaveLength(0);
    }
    const [user] = await database.db.select().from(users).where(eq(users.email, p.email));
    expect(Object.keys(user!).sort()).toEqual(
      ["blockedReason", "createdAt", "deletedAt", "email", "id", "nickname", "role", "status", "termsAcceptedAt"].sort(),
    );
  });

  it("conta 21: a rota não aceita idade nem data de nascimento", async () => {
    const p = await person();
    await invite(p.email);
    const res = await register(p.token, { nickname: "idade_21", acceptTerms: true, birthDate: "2015-05-01" });
    expect(res.statusCode).toBe(400);
    expect(res.json().fields).toContain("(corpo)");
  });

  it("o mesmo convite não serve para uma segunda conta", async () => {
    const p = await person();
    await invite(p.email);
    expect((await register(p.token, { nickname: "uma_vez", acceptTerms: true })).statusCode).toBe(201);
    const again = await register(p.token, { nickname: "outra_vez", acceptTerms: true });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("already_registered");
  });

  it("primeiro admin: o e-mail de ADMIN_BOOTSTRAP_EMAIL entra sem convite e nasce admin; outro nasce jogador", async () => {
    const thaian = await person("Thaian@Exemplo.com");
    const res = await register(thaian.token, { nickname: "thaian", acceptTerms: true });
    expect(res.statusCode).toBe(201);
    expect(res.json().role).toBe("admin");
    const p = await person();
    await invite(p.email);
    expect((await register(p.token, { nickname: "comum_1", acceptTerms: true })).json().role).toBe("player");
  });

  it("corrida: duas pessoas pedem o mesmo apelido ao mesmo tempo, uma passa e a outra recebe nickname_taken", async () => {
    const a = await person();
    const b = await person();
    await invite(a.email);
    await invite(b.email);
    const results = await Promise.all([
      register(a.token, { nickname: "disputado", acceptTerms: true }),
      register(b.token, { nickname: "DISPUTADO", acceptTerms: true }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.statusCode === 409)!.json().code).toBe("nickname_taken");
  });

  it("corrida: a mesma pessoa manda o cadastro duas vezes ao mesmo tempo e só uma conta nasce", async () => {
    const p = await person();
    await invite(p.email);
    const results = await Promise.all([
      register(p.token, { nickname: "duplo_1", acceptTerms: true }),
      register(p.token, { nickname: "duplo_2", acceptTerms: true }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(await database.db.select().from(users).where(eq(users.email, p.email))).toHaveLength(1);
  });

  it("conta excluída recebe 401 em GET /me e POST /me", async () => {
    const davi = await createAccount(database.db, { status: "deleted" });
    const token = await davi.tokenWith({ at: clock.now() });
    expect((await app.inject({ method: "GET", url: "/me", headers: bearer(token) })).statusCode).toBe(401);
    expect((await register(token, { nickname: "davi_volta", acceptTerms: true })).statusCode).toBe(401);
  });

  it("token de outro usuário: GET /me com o token de Bruno mostra Bruno, com o e-mail dele e nada de Ana", async () => {
    const ana = await createAccount(database.db, { nickname: "ana_me" });
    const bruno = await createAccount(database.db, { nickname: "bruno_me" });
    const res = await app.inject({ method: "GET", url: "/me", headers: bearer(await bruno.tokenWith({ at: clock.now() })) });
    expect(res.json()).toMatchObject({ registered: true, id: bruno.id, nickname: "bruno_me", email: bruno.email });
    expect(res.body).not.toContain(ana.email);
  });
});
