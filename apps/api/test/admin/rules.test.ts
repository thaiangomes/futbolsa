import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cupViewSchema, seasonRulesSchema } from "@futbolsa/contracts";
import { COPA_DO_BRASIL } from "@futbolsa/engine";
import { FixedClock } from "../../src/infra/clock/index.js";
import { withTransaction } from "../../src/infra/db/index.js";
import { adminLog, cupPhases, matches, seasonCups, seasonRules, seasons } from "../../src/infra/db/schema/index.js";
import { SeasonValuesService } from "../../src/modules/dividends/season-values/season-values.service.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { expectAdminOnly } from "../support/admin-routes.js";
import { createTestApp } from "../support/app.js";
import { bearer, TOKEN_T0, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { seedSeason } from "../support/fixtures.js";

/** A Copa do Brasil de 2026 tinha nove fases (a 4ª e a 5ª fase são novas). */
const NOVE_FASES = [
  { phaseKey: "1a-fase", variant: "advance", perShare: 50 },
  { phaseKey: "2a-fase", variant: "advance", perShare: 60 },
  { phaseKey: "3a-fase", variant: "advance", perShare: 75 },
  { phaseKey: "4a-fase", variant: "advance", perShare: 90 },
  { phaseKey: "5a-fase", variant: "advance", perShare: 100 },
  { phaseKey: "oitavas", variant: "advance", perShare: 150 },
  { phaseKey: "quartas", variant: "advance", perShare: 250 },
  { phaseKey: "semifinal", variant: "advance", perShare: 400 },
  { phaseKey: "final", variant: "title", perShare: 800 },
];

describe("regras e copas da temporada", () => {
  const database = useTestDatabase(8);
  const clock = new FixedClock(new Date(TOKEN_T0.getTime() + 60_000));
  let app: NestFastifyApplication;
  let admin: TestAccount;
  let seasonId: number;
  let clubIds: Map<string, number>;
  let values: SeasonValuesService;

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    admin = await createAccount(database.db, { role: "admin", nickname: "chefe" });
    ({ seasonId, clubIds } = await seedSeason(database.db));
    values = app.get(SeasonValuesService, { strict: false });
  });
  afterAll(() => app.close());

  const call = (method: "GET" | "PUT" | "POST", url: string, payload?: object) =>
    app.inject({ method, url, headers: bearer(admin.token), ...(payload ? { payload } : {}) });
  const cup = async (competition: string) => cupViewSchema.parse((await call("GET", `/admin/seasons/${seasonId}/rules`)).json().cups.find((c: { competition: string }) => c.competition === competition));
  const logs = (action: string) => database.db.select().from(adminLog).where(eq(adminLog.action, action));

  it("admin 31: jogador comum não acessa as rotas das regras e das copas", async () => {
    await expectAdminOnly(app, database.db, { method: "GET", url: `/admin/seasons/${seasonId}/rules` }, { okStatus: 200 });
    await expectAdminOnly(app, database.db, { method: "PUT", url: `/admin/seasons/${seasonId}/rules`, payload: { aPerPoint: 10 } });
    await expectAdminOnly(app, database.db, { method: "PUT", url: `/admin/seasons/${seasonId}/cups/libertadores`, payload: { phases: [{ phaseKey: "final", variant: "title", perShare: 1200 }] } });
    await expectAdminOnly(app, database.db, { method: "POST", url: `/admin/seasons/${seasonId}/cups/libertadores/confirm` });
  });

  it("os valores iniciais vêm das constantes do motor, sem violações, e a temporada do seed ganha os dela na primeira consulta", async () => {
    const res = await call("GET", `/admin/seasons/${seasonId}/rules`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(seasonRulesSchema.parse(body.rules)).toMatchObject({ aPerPoint: 10, bPerPoint: 5, promotionPerShare: 200, promotionSlots: 4, buybackMultipleBp: 15000, lockedAt: null });
    expect(body.rules.aPlacement).toHaveLength(16);
    expect(body.cups.map((c: { competition: string }) => c.competition)).toEqual(["copa-do-brasil", "libertadores", "sulamericana"]);
    for (const c of body.cups) expect(cupViewSchema.parse(c)).toMatchObject({ violations: [] });
  });

  it("dividendos 28: a Copa do Brasil de 2026 com nove fases é montada e confirmada", async () => {
    const put = await call("PUT", `/admin/seasons/${seasonId}/cups/copa-do-brasil`, { phases: NOVE_FASES });
    expect(put.statusCode).toBe(200);
    const view = cupViewSchema.parse(put.json());
    expect(view.phases).toHaveLength(9);
    expect(view.phases.map((p) => p.phaseKey)).toEqual(NOVE_FASES.map((p) => p.phaseKey));
    expect(view.violations).toEqual([]);
    const confirmed = await call("POST", `/admin/seasons/${seasonId}/cups/copa-do-brasil/confirm`);
    expect(confirmed.statusCode).toBe(200);
    expect(cupViewSchema.parse(confirmed.json())).toMatchObject({ confirmedBy: "chefe", confirmedAt: clock.now().toISOString() });
    // a tabela gravada volta ao motor com as nove fases
    const loaded = await withTransaction(database.db, (tx) => values.loadSeasonValues(tx, seasonId));
    expect(loaded.cups["copa-do-brasil"]!.phases).toHaveLength(9);
    expect(loaded.cups["copa-do-brasil"]!.advance["4a-fase"]).toBe(90);
  });

  it("editar uma copa confirmada tira a confirmação dela, e só dela", async () => {
    await call("POST", `/admin/seasons/${seasonId}/cups/libertadores/confirm`);
    expect((await cup("libertadores")).confirmedAt).not.toBeNull();
    expect((await cup("copa-do-brasil")).confirmedAt).not.toBeNull();
    const phases = (await cup("copa-do-brasil")).phases.map((p) => (p.phaseKey === "oitavas" ? { ...p, perShare: 160 } : p));
    const res = await call("PUT", `/admin/seasons/${seasonId}/cups/copa-do-brasil`, { phases });
    expect(cupViewSchema.parse(res.json())).toMatchObject({ confirmedAt: null, confirmedBy: null });
    expect((await cup("libertadores")).confirmedAt).not.toBeNull();
    const [row] = await database.db.select().from(seasonCups).where(and(eq(seasonCups.seasonId, seasonId), eq(seasonCups.competition, "copa-do-brasil")));
    expect(row!.confirmedAt).toBeNull();
    expect((await logs("cup.update")).length).toBeGreaterThan(0);
  });

  it("tabela que quebra as regras volta com os avisos e é aceita (só avisar); confirmar com avisos grava os avisos no registro", async () => {
    // o valor da semifinal fica abaixo da fase anterior, e o título deixa de ser o dobro da semifinal
    const broken = NOVE_FASES.map((p) => (p.phaseKey === "semifinal" ? { ...p, perShare: 100 } : p));
    const put = await call("PUT", `/admin/seasons/${seasonId}/cups/libertadores`, { phases: broken.map((p) => ({ ...p, perShare: p.perShare })) });
    expect(put.statusCode).toBe(200);
    const view = cupViewSchema.parse(put.json());
    expect(view.violations.length).toBeGreaterThan(0);
    expect(view.violations.every((v) => v.code && v.message)).toBe(true);
    const res = await call("POST", `/admin/seasons/${seasonId}/cups/libertadores/confirm`);
    expect(res.statusCode).toBe(200);
    const [log] = (await logs("cup.confirm")).filter((l) => l.targetId === "libertadores").slice(-1);
    expect(log).toMatchObject({ actorId: admin.id, targetType: "cup" });
    expect((log!.after as { violations: unknown[] }).violations).toEqual(view.violations);
  });

  it("cada copa é validada sozinha: o aviso de uma não aparece na outra", async () => {
    const libertadores = await cup("libertadores");
    const sula = await cup("sulamericana");
    expect(libertadores.violations.length).toBeGreaterThan(0);
    expect(sula.violations).toEqual([]);
  });

  it("fases dos jogos que ainda não têm valor na tabela são avisadas (as preliminares não pagam)", async () => {
    await database.db.insert(matches).values([
      { seasonId, competition: "sulamericana", phase: "pre-1", homeClubId: clubIds.get("FLA3")!, awayClubId: clubIds.get("PAL3")!, kickoff: clock.now(), source: "t", sourceId: "p1" },
      { seasonId, competition: "sulamericana", phase: "dezesseis-avos", homeClubId: clubIds.get("FLA3")!, awayClubId: clubIds.get("PAL3")!, kickoff: clock.now(), source: "t", sourceId: "p2" },
      { seasonId, competition: "sulamericana", phase: "oitavas", homeClubId: clubIds.get("FLA3")!, awayClubId: clubIds.get("PAL3")!, kickoff: clock.now(), source: "t", sourceId: "p3" },
    ]);
    expect((await cup("sulamericana")).phasesWithoutValue).toEqual(["dezesseis-avos"]);
  });

  it("linhas repetidas na mesma fase e variante são recusadas, e a tabela não muda", async () => {
    const before = await cup("sulamericana");
    const res = await call("PUT", `/admin/seasons/${seasonId}/cups/sulamericana`, {
      phases: [
        { phaseKey: "grupos", variant: "advance", perShare: 60 },
        { phaseKey: "grupos", variant: "advance", perShare: 70 },
        { phaseKey: "final", variant: "title", perShare: 480 },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "invalid_input", fields: ["phases"] });
    expect(await cup("sulamericana")).toEqual(before);
  });

  it("os valores das ligas são editáveis em centavos e registrados com o antes e o depois", async () => {
    const before = (await call("GET", `/admin/seasons/${seasonId}/rules`)).json().rules;
    const { lockedAt: _locked, ...editable } = before;
    const res = await call("PUT", `/admin/seasons/${seasonId}/rules`, { ...editable, aPerPoint: 12, reason: "inflação do jogo" });
    expect(res.statusCode).toBe(200);
    expect(seasonRulesSchema.parse(res.json())).toMatchObject({ aPerPoint: 12 });
    const [log] = (await logs("season.rules.update")).slice(-1);
    expect(log).toMatchObject({ reason: "inflação do jogo", before: expect.objectContaining({ aPerPoint: 10 }), after: expect.objectContaining({ aPerPoint: 12 }) });
    const bad = await call("PUT", `/admin/seasons/${seasonId}/rules`, { ...editable, aPerPoint: -1 });
    expect(bad.statusCode).toBe(400);
  });

  it("dividendos 28: temporada fora da preparação recusa mudar os valores mesmo sem locked_at", async () => {
    await database.db.update(seasons).set({ status: "trading" }).where(eq(seasons.id, seasonId));
    try {
      const { lockedAt, ...editable } = (await call("GET", `/admin/seasons/${seasonId}/rules`)).json().rules;
      expect(lockedAt).toBeNull();
      const rules = await call("PUT", `/admin/seasons/${seasonId}/rules`, { ...editable, aPerPoint: 77 });
      expect(rules.statusCode).toBe(409);
      expect(rules.json().code).toBe("season_locked");
      expect((await call("PUT", `/admin/seasons/${seasonId}/cups/copa-do-brasil`, { phases: NOVE_FASES })).statusCode).toBe(409);
      expect((await call("POST", `/admin/seasons/${seasonId}/cups/copa-do-brasil/confirm`)).statusCode).toBe(409);
      const [stored] = await database.db.select().from(seasonRules).where(eq(seasonRules.seasonId, seasonId));
      expect(stored!.aPerPoint).toBe(12);
    } finally {
      await database.db.update(seasons).set({ status: "preparing" }).where(eq(seasons.id, seasonId));
    }
  });

  it("dividendos 26 e 28: com o IPO aberto, mudar a tabela e os valores é recusado", async () => {
    await withTransaction(database.db, (tx) => values.lockSeasonValues(tx, seasonId, clock.now()));
    const before = (await call("GET", `/admin/seasons/${seasonId}/rules`)).json().rules;
    const { lockedAt, ...editable } = before;
    expect(lockedAt).not.toBeNull();
    const rules = await call("PUT", `/admin/seasons/${seasonId}/rules`, { ...editable, aPerPoint: 99 });
    expect(rules.statusCode).toBe(409);
    expect(rules.json().code).toBe("season_locked");
    const cupRes = await call("PUT", `/admin/seasons/${seasonId}/cups/copa-do-brasil`, { phases: NOVE_FASES });
    expect(cupRes.statusCode).toBe(409);
    expect((await call("POST", `/admin/seasons/${seasonId}/cups/copa-do-brasil/confirm`)).statusCode).toBe(409);
    const [stored] = await database.db.select().from(seasonRules).where(eq(seasonRules.seasonId, seasonId));
    expect(stored!.aPerPoint).toBe(12);
    const rows = await database.db.select().from(cupPhases).where(and(eq(cupPhases.seasonId, seasonId), eq(cupPhases.competition, "copa-do-brasil")));
    expect(rows.length).toBe(NOVE_FASES.length);
    expect(COPA_DO_BRASIL.phases).toHaveLength(7);
  });

  it("temporada que não existe volta 404", async () => {
    expect((await call("GET", "/admin/seasons/999999/rules")).statusCode).toBe(404);
  });

  it("duas primeiras consultas ao mesmo tempo dão 200 com os mesmos valores, gravados uma vez só (20 repetições)", async () => {
    for (let i = 0; i < 20; i++) {
      // temporada antiga, sem valores: as duas consultas tentam criá-los ao mesmo tempo
      const [season] = await database.db.insert(seasons).values({ year: 2100 + i, status: "closed" }).returning();
      const url = `/admin/seasons/${season!.id}/rules`;
      const [first, second] = await Promise.all([call("GET", url), call("GET", url)]);
      expect([first.statusCode, second.statusCode], `repetição ${i}: ${first.body} ${second.body}`).toEqual([200, 200]);
      expect(second.json()).toEqual(first.json());
      expect(await database.db.select().from(seasonRules).where(eq(seasonRules.seasonId, season!.id))).toHaveLength(1);
      expect(await database.db.select().from(seasonCups).where(eq(seasonCups.seasonId, season!.id))).toHaveLength(3);
    }
  });
});
