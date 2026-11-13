import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, eq, ne, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixedClock } from "../../src/infra/clock/index.js";
import { type Database, withTransaction } from "../../src/infra/db/index.js";
import { clubs, fraudCases, matches, rankingRows, rankingSnapshots, seasonResults, seasons, users, wallets } from "../../src/infra/db/schema/index.js";
import { AccountDeletionService } from "../../src/modules/accounts/index.js";
import { BotRunner } from "../../src/modules/admin/bots/runner.js";
import { AlertScan } from "../../src/modules/admin/fraud/alert-scan.js";
import { CloseEventsJob } from "../../src/modules/admin/payouts/close-events.job.js";
import { CorrectionPlanService } from "../../src/modules/admin/payouts/correction-plan.js";
import { RankingsPort } from "../../src/modules/admin/payouts/ports.js";
import { SettleCreditsService } from "../../src/modules/admin/payouts/settle-credits.js";
import { ImportService } from "../../src/modules/admin/results/import.service.js";
import { StandingsService } from "../../src/modules/admin/standings/standings.service.js";
import { IpoJob } from "../../src/modules/ipo/index.js";
import { OpeningJob, RefreshJob, RefreshWaker } from "../../src/modules/market/index.js";
import { EquityDailyService, SnapshotService } from "../../src/modules/portfolio/index.js";
import { CloseService, LiveService, RecalcService } from "../../src/modules/rankings/index.js";
import { createTestApp } from "../support/app.js";
import { tokenFor, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { after, prepareCalls, RecordingRankings, type Season, SilentWaker } from "../payouts/correction-scene.js";
import { at, buybackScene, REGISTERED } from "./buyback-scene.js";

const C = at("2027-12-20T15:00:00Z");

/**
 * A foto das tabelas da temporada: um hash por tabela de tudo o que aponta para ela (pela temporada, pela carteira, pelo
 * evento de pagamento, pelo ranking ou pelo caso de trapaça). As tabelas vêm do catálogo, então tabela nova entra sozinha.
 */
async function fingerprint(db: Database, seasonId: number): Promise<Record<string, string>> {
  const { rows } = await db.execute(sql`
    select table_name, array_agg(column_name::text) as cols from information_schema.columns
    where table_schema = 'futbolsa' and column_name in ('season_id', 'wallet_id', 'event_id', 'snapshot_id', 'case_id')
    group by table_name order by table_name`);
  const out: Record<string, string> = {};
  const S = seasonId;
  const filters: Record<string, ReturnType<typeof sql>> = {
    season_id: sql`season_id = ${S}`,
    wallet_id: sql`wallet_id in (select id from futbolsa.wallets where season_id = ${S})`,
    event_id: sql`event_id in (select id from futbolsa.payout_events where season_id = ${S})`,
    snapshot_id: sql`snapshot_id in (select id from futbolsa.ranking_snapshots where season_id = ${S})`,
    case_id: sql`case_id in (select id from futbolsa.fraud_cases where season_id = ${S})`,
  };
  for (const r of rows) {
    const table = String(r.table_name);
    const cols = r.cols as string[];
    const col = ["season_id", "wallet_id", "event_id", "snapshot_id", "case_id"].find((c) => cols.includes(c))!;
    // `event_id` fora dos pagamentos aponta para outra coisa
    if (col === "event_id" && !table.startsWith("payout_")) continue;
    const res = await db.execute(sql`
      select count(*)::int as n, coalesce(md5(string_agg(t::text, '|' order by t::text)), '') as h
      from ${sql.raw(`futbolsa.${table}`)} t where ${filters[col]!}`);
    out[table] = `${res.rows[0]!.n}:${res.rows[0]!.h}`;
  }
  const season = await db.execute(sql`select md5(t::text) as h from futbolsa.seasons t where id = ${S}`);
  out.seasons = String(season.rows[0]!.h);
  return out;
}

describe("nada muda depois do encerramento (F15, T7)", () => {
  const t = useTestDatabase(30);
  const clock = new FixedClock(REGISTERED);
  const rankings = new RecordingRankings();
  let app: NestFastifyApplication;
  const scene = buybackScene(() => t.db, () => app, clock, 2027);
  const w = { ana: 0, bia: 0, bot: 0, caio: 0 };
  let s: Season;
  let fraudCase = 0;

  beforeAll(async () => {
    rankings.db = t.db;
    await prepareCalls(t.db);
    app = await createTestApp({
      db: t.db,
      clock,
      override: (b) => withTestAuth(clock)(b).overrideProvider(RankingsPort).useValue(rankings).overrideProvider(RefreshWaker).useValue(new SilentWaker()),
    });
    await scene.init();
    // a temporada do seed (a de antes) fica encerrada: a única fora de `closed` é a dos testes
    await t.db.update(seasons).set({ status: "closed", closedAt: at("2026-12-20T15:00:00Z") }).where(ne(seasons.status, "closed"));

    s = await scene.newSeason();
    await t.db.update(seasons).set({ ipoOpensAt: at("2027-03-28T19:00:00Z") }).where(eq(seasons.id, s.seasonId));
    w.ana = await scene.player(s);
    w.bia = await scene.player(s, undefined, "blocked");
    w.caio = await scene.player(s);
    w.bot = await scene.bot(s);
    await scene.buy(s, w.ana, "FLA3", 1_000);
    await scene.buy(s, w.caio, "PAL3", 500);
    await scene.buy(s, w.bot, "SAO3", 300);
    await scene.seasonEnd(s);
    expect((await scene.close(s.seasonId, REGISTERED)).errors).toEqual([]);
    await scene.approveAll(after(REGISTERED, 30));
    // um caso de trapaça já decidido (o aberto impediria o encerramento)
    const [row] = await t.db
      .insert(fraudCases)
      .values({ seasonId: s.seasonId, origin: "alert", status: "confirmed", walletLow: w.ana, walletHigh: w.caio, clubId: scene.club("FLA3"), periodFrom: REGISTERED, periodTo: REGISTERED, openedAt: REGISTERED, decidedAt: REGISTERED })
      .returning({ id: fraudCases.id });
    fraudCase = Number(row!.id);
    const res = await call("POST", `/admin/seasons/${s.seasonId}/close`, { confirmYear: (await scene.seasonOf(s)).year }, C);
    expect(res.statusCode).toBe(200);
  });
  afterAll(async () => {
    await app?.get(SettleCreditsService, { strict: false }).whenIdle();
    await app?.close();
  });

  async function call(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: object, now: Date = after(C, 60), headers: Record<string, string> = {}) {
    clock.set(now);
    const token = await scene.admin.tokenWith({ at: now });
    return app.inject({ method, url, ...(payload ? { payload } : {}), headers: { authorization: `Bearer ${token}`, ...headers } });
  }
  const service = <T>(type: abstract new (...args: never[]) => T): T => app.get(type as never, { strict: false }) as T;
  const userOf = async (walletId: number) => (await t.db.select().from(wallets).where(eq(wallets.id, walletId)))[0]!.userId!;
  const matchOf = async (competition: string) => (await t.db.select().from(matches).where(and(eq(matches.seasonId, s.seasonId), eq(matches.competition, competition))))[0]!;
  const codeOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
      return "ok";
    } catch (error) {
      return (error as { code?: string }).code ?? (error as Error).message;
    }
  };

  it("admin 18: temporada encerrada não aceita correção de jogo, de classificação nem de pagamento", async () => {
    const before = await fingerprint(t.db, s.seasonId);
    const match = await matchOf("copa-do-brasil");
    const game = await call("PATCH", `/admin/matches/${match.id}`, { homeGoals: 0, awayGoals: 1, reason: "placar errado" });
    expect(game.statusCode).toBe(409);
    expect(game.json().code).toBe("season_closed");

    const b = await t.db.select().from(clubs).where(eq(clubs.id, scene.club("GRE3")));
    const table = await call("PATCH", "/admin/standings/brasileirao-b", { order: [b[0]!.id, scene.idOf("out1"), scene.idOf("out2"), scene.idOf("out3")], reason: "ordem errada" });
    expect(table.statusCode).toBe(409);
    expect(table.json().code).toBe("season_closed");
    const confirm = await call("POST", "/admin/standings/brasileirao-b/confirm");
    expect(confirm.json().code).toBe("season_closed");

    const approve = await call("POST", "/admin/payouts/approve", { all: true });
    expect(approve.statusCode).toBe(409);
    expect(approve.json().code).toBe("season_closed");
    const correction = await call("POST", "/admin/payouts/corrections", { planCode: "qualquer", reason: "corrigir" });
    expect(correction.statusCode).toBe(409);
    expect(correction.json().code).toBe("season_closed");
    expect(await codeOf(service(CorrectionPlanService).plan(t.db, s.seasonId, after(C, 60)))).toBe("season_closed");
    // pelos serviços, com o id da temporada: a importação de placares e da classificação
    expect(await codeOf(service(ImportService).importMatches(s.seasonId, "copa-do-brasil", []))).toBe("season_closed");
    expect(await codeOf(service(StandingsService).importStandings(s.seasonId, "brasileirao-b", []))).toBe("season_closed");
    expect(await fingerprint(t.db, s.seasonId)).toEqual(before);
  });

  it("confirmar, descartar ou banir num caso de trapaça da temporada encerrada é recusado com season_closed", async () => {
    const before = await fingerprint(t.db, s.seasonId);
    const confirm = await call("POST", `/admin/fraud/cases/${fraudCase}/confirm`, { tradeIds: [1], reason: "trapaça" }, after(C, 60), { "idempotency-key": "frozen-confirm" });
    expect(confirm.json().code).toBe("season_closed");
    const dismiss = await call("POST", `/admin/fraud/cases/${fraudCase}/dismiss`, { reason: "não era" });
    expect(dismiss.json().code).toBe("season_closed");
    const ban = await call("POST", `/admin/fraud/cases/${fraudCase}/ban`, { userId: await userOf(w.ana), reason: "reincidente" });
    expect(ban.json().code).toBe("season_closed");
    const open = await call("POST", "/admin/fraud/cases", { accountA: { userId: await userOf(w.ana) }, accountB: { userId: await userOf(w.caio) }, from: REGISTERED.toISOString(), to: C.toISOString() });
    expect(open.json().code).toBe("season_closed");
    expect(await fingerprint(t.db, s.seasonId)).toEqual(before);
  });

  it("a foto das tabelas da temporada não muda depois de chamar as rotas de escrita do admin e do jogador e rodar todas as tarefas", async () => {
    const before = await fingerprint(t.db, s.seasonId);
    const year = (await scene.seasonOf(s)).year;
    const ana = await userOf(w.ana);
    const [anaUser] = await t.db.select().from(users).where(eq(users.id, ana));
    const match = await matchOf("libertadores");
    const codes: Record<string, string> = {};
    // corpos válidos: a recusa vem do serviço, não da validação
    const rules = ((await call("GET", `/admin/seasons/${s.seasonId}/rules`)).json() as { rules: Record<string, unknown> }).rules;
    delete rules.lockedAt;
    const listed = await t.db.select({ id: clubs.id }).from(clubs).where(sql`${clubs.ticker} is not null`).orderBy(clubs.id);
    const clubList = listed.slice(0, 20).map((c, i) => ({ clubId: c.id, division: "A", prevPlacement: i + 1 }));
    expect(clubList).toHaveLength(20);
    const routes: Array<[string, "POST" | "PATCH" | "PUT" | "DELETE", string, object | undefined, Record<string, string>?]> = [
      ["jogo novo", "POST", "/admin/matches", { competition: "brasileirao-a", round: 2, homeClubId: scene.club("FLA3"), awayClubId: scene.club("PAL3"), kickoff: C.toISOString(), reason: "faltou" }],
      ["corrigir jogo", "PATCH", `/admin/matches/${match.id}`, { status: "scheduled", reason: "voltar" }],
      ["importar agora", "POST", "/admin/imports/run", {}],
      ["oferta", "PATCH", `/admin/seasons/${s.seasonId}`, { offerSize: 5_000 }],
      ["bots nos rankings", "PATCH", `/admin/seasons/${s.seasonId}`, { botsInRankings: true }],
      ["clubes", "PUT", `/admin/seasons/${s.seasonId}/clubs`, { clubs: clubList }],
      ["valores", "PUT", `/admin/seasons/${s.seasonId}/rules`, { ...rules, bPerPoint: 300 }],
      ["encerrar de novo", "POST", `/admin/seasons/${s.seasonId}/close`, { confirmYear: year }],
      ["ajuste de caixa", "POST", `/admin/players/${ana}/adjust`, { asset: "cash", delta: 100_000, reason: "ajuste" }, { "idempotency-key": "frozen-adjust" }],
      ["ajuste de ações", "POST", `/admin/players/${ana}/adjust`, { asset: "shares", ticker: "FLA3", delta: 10, reason: "ajuste" }, { "idempotency-key": "frozen-adjust-2" }],
      ["bloquear", "POST", `/admin/players/${ana}/block`, { reason: "teste" }],
      ["desbloquear", "POST", `/admin/players/${ana}/unblock`, { reason: "teste" }],
      ["desbloquear Bia", "POST", `/admin/players/${await userOf(w.bia)}/unblock`, { reason: "teste" }],
      ["bots", "PATCH", "/admin/bots", { counts: { dividendos: 3 } }],
      ["suspender", "POST", "/admin/suspensions", { reason: "teste" }],
      ["suspender clube", "POST", "/admin/suspensions", { ticker: "FLA3", reason: "teste" }],
      ["formador", "PATCH", "/admin/market-maker", { mmQuantityBp: 100, reason: "teste" }],
      ["aprovar", "POST", "/admin/payouts/approve", { all: true }],
    ];
    for (const [name, method, url, payload, headers] of routes) {
      const res = await call(method, url, payload, after(C, 60), headers);
      codes[name] = `${res.statusCode} ${res.json()?.code ?? ""}`;
    }
    // as que escreveriam na temporada encerrada recusam com season_closed; as da temporada atual (não há) com no_season;
    // bloquear, desbloquear e os bots mexem só na conta e no bot, não na temporada
    for (const name of ["jogo novo", "corrigir jogo", "oferta", "bots nos rankings", "clubes", "valores", "encerrar de novo", "ajuste de caixa", "ajuste de ações", "aprovar"]) {
      expect(codes[name], name).toBe("409 season_closed");
    }
    for (const name of ["suspender", "suspender clube", "formador"]) expect(codes[name], name).toBe("409 no_season");
    for (const name of ["importar agora", "bloquear", "desbloquear", "desbloquear Bia", "bots"]) expect(codes[name], name).toMatch(/^200/);

    // o jogador: ordem, cancelar, oferta do IPO, entrada no meio, carteira e histórico
    const anaToken = await tokenFor({ subject: (await subjectOf(ana))!, email: `${anaUser!.nickname}@exemplo.com`, at: after(C, 60) });
    const asAna = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object, headers: Record<string, string> = {}) =>
      app.inject({ method, url, ...(payload ? { payload } : {}), headers: { authorization: `Bearer ${anaToken}`, ...headers } });
    const playerCodes = [
      await asAna("POST", "/orders", { ticker: "FLA3", side: "buy", type: "limit", quantity: 1, limitPrice: 100 }, { "idempotency-key": "frozen-order" }),
      await asAna("DELETE", "/orders/1"),
      await asAna("PUT", "/ipo/bids/FLA3", { quantity: 10, price: 100 }),
      await asAna("POST", "/entry", { mode: "cash" }),
      await asAna("GET", "/portfolio"),
      await asAna("GET", "/me/history"),
    ].map((r) => r.statusCode);
    expect(playerCodes.slice(0, 4).every((code) => code >= 400)).toBe(true);

    // as tarefas agendadas
    const later = after(C, 24 * 60 * 15);
    clock.set(later);
    await service(CloseEventsJob).runCurrent();
    await service(CloseEventsJob).run(s.seasonId);
    await service(SettleCreditsService).settlePending();
    for (const e of await scene.buybacksOf(s)) await service(SettleCreditsService).settleEvent(e.id);
    await service(CloseService).runOnce(later);
    await service(CloseService).runOnce(at("2028-01-01T03:30:00Z"));
    await withTransaction(t.db, (tx) => service(CloseService).closeMonthsDue(tx, s.seasonId, at("2028-01-01T03:30:00Z")));
    await service(RecalcService).processRecalcRequests(later);
    await service(LiveService).publishIfChanged();
    await service(SnapshotService).runOnce(at("2028-01-01T03:30:00Z"));
    await service(EquityDailyService).runOnce(at("2027-12-21T03:30:00Z"));
    await service(BotRunner).runOnce(later, () => 0.5);
    await service(RefreshJob).runDue(later);
    await service(RefreshJob).runRequested({ seasonId: s.seasonId, tickers: ["FLA3"] }, later);
    await service(OpeningJob).runOnce(later);
    await service(IpoJob).runOnce();
    await service(AccountDeletionService).closeoutPending();
    await service(AlertScan).scan();

    expect(await fingerprint(t.db, s.seasonId)).toEqual(before);
    expect(await scene.seasonOf(s)).toMatchObject({ status: "closed", closedAt: C });
  });

  it("com a temporada seguinte em preparação, as rotas e as tarefas mexem só nela", async () => {
    const before = await fingerprint(t.db, s.seasonId);
    const year = (await scene.seasonOf(s)).year + 1;
    const created = await call("POST", "/admin/seasons", { year });
    expect(created.statusCode).toBe(201);
    const next = created.json().id as number;
    await call("PATCH", `/admin/seasons/${next}`, { offerSize: 5_000 });
    await call("PATCH", "/admin/bots", { counts: { dividendos: 2 } });
    const later = after(C, 24 * 60 * 30);
    clock.set(later);
    await service(CloseEventsJob).runCurrent();
    await service(SettleCreditsService).settlePending();
    await service(CloseService).runOnce(later);
    await service(SnapshotService).runOnce(later);
    await service(EquityDailyService).runOnce(later);
    await service(BotRunner).runOnce(later, () => 0.5);
    await service(IpoJob).runOnce();
    await service(AccountDeletionService).closeoutPending();
    expect(await fingerprint(t.db, s.seasonId)).toEqual(before);
    // a temporada de teste volta a ser a única fora de closed para o teste seguinte
    await t.db.update(seasons).set({ status: "closed", closedAt: later }).where(eq(seasons.id, next));
  });

  it("excluir a conta depois do encerramento mantém a linha 'conta excluída' no anual e o season_results", async () => {
    const caio = await userOf(w.caio);
    const [annual] = await t.db.select().from(rankingSnapshots).where(and(eq(rankingSnapshots.seasonId, s.seasonId), eq(rankingSnapshots.period, "season")));
    const rowBefore = (await t.db.select().from(rankingRows).where(and(eq(rankingRows.snapshotId, annual!.id), eq(rankingRows.walletId, w.caio))))[0];
    expect(rowBefore).toBeDefined();
    const [resultBefore] = await t.db.select().from(seasonResults).where(and(eq(seasonResults.userId, caio), eq(seasonResults.seasonId, s.seasonId)));
    const before = await fingerprint(t.db, s.seasonId);

    clock.set(after(C, 24 * 60 * 40));
    expect(await service(AccountDeletionService).deleteAccount(caio)).toEqual({ walletCloseout: "done" });
    expect((await t.db.select().from(users).where(eq(users.id, caio)))[0]).toMatchObject({ status: "deleted", nickname: null });
    // nada da temporada mudou: a linha do anual e o histórico ficam
    expect(await fingerprint(t.db, s.seasonId)).toEqual(before);
    const [resultAfter] = await t.db.select().from(seasonResults).where(and(eq(seasonResults.userId, caio), eq(seasonResults.seasonId, s.seasonId)));
    expect(resultAfter).toEqual(resultBefore);
    // e o ranking anual mostra a linha como "conta excluída" (sem apelido)
    const res = await call("GET", `/rankings/season/${(await scene.seasonOf(s)).year}`);
    expect(res.statusCode).toBe(200);
    const rows = res.json().rows as Array<{ displayName: string | null; position: number; isBot: boolean }>;
    expect(rows.filter((r) => !r.isBot && r.displayName === null).map((r) => r.position)).toEqual([rowBefore!.position]);
  });

  it("admin 37: com a recompra fechada, a importação não traz jogo novo nem volta jogo disputado para agendado, e o placar corrigido entra", async () => {
    const s2 = await scene.newSeason();
    await scene.seasonEnd(s2);
    expect((await scene.close(s2.seasonId, REGISTERED)).errors).toEqual([]);
    expect(await scene.seasonOf(s2)).toMatchObject({ status: "trading_ended" });
    const [game] = await t.db.select().from(matches).where(and(eq(matches.seasonId, s2.seasonId), eq(matches.competition, "brasileirao-a")));
    await t.db.update(matches).set({ source: "espn", sourceId: "a-final" }).where(eq(matches.id, game!.id));
    const nameOf = async (id: number) => (await t.db.select({ name: clubs.name }).from(clubs).where(eq(clubs.id, id)))[0]!.name;
    const home = await nameOf(game!.homeClubId);
    const away = await nameOf(game!.awayClubId);
    const source = (o: { id: string; status: "scheduled" | "finished"; goals: [number, number] | null; round?: number; home?: string; away?: string }) => ({
      source: "espn",
      sourceId: o.id,
      competition: "brasileirao-a" as const,
      round: o.round ?? 1,
      phase: null,
      kickoff: game!.kickoff,
      status: o.status,
      homeName: o.home ?? home,
      awayName: o.away ?? away,
      homeGoals: o.goals?.[0] ?? null,
      awayGoals: o.goals?.[1] ?? null,
      advancedName: null,
    });
    const imports = service(ImportService);
    clock.set(after(REGISTERED, 60));
    const reopen = await imports.importMatches(s2.seasonId, "brasileirao-a", [
      source({ id: "a-final", status: "scheduled", goals: null }),
      source({ id: "a-novo", status: "scheduled", goals: null, round: 2, home: away, away: home }),
    ]);
    expect(reopen).toMatchObject({ inserted: 0, updated: 0, unchanged: 2 });
    const rows = await t.db.select().from(matches).where(and(eq(matches.seasonId, s2.seasonId), eq(matches.competition, "brasileirao-a")));
    expect(rows).toEqual([expect.objectContaining({ id: game!.id, status: "finished", homeGoals: 1, awayGoals: 1 })]);
    // o placar corrigido pela fonte entra (só muda os valores)
    const score = await imports.importMatches(s2.seasonId, "brasileirao-a", [source({ id: "a-final", status: "finished", goals: [2, 1] })]);
    expect(score).toMatchObject({ updated: 1 });
    expect((await t.db.select().from(matches).where(eq(matches.id, game!.id)))[0]).toMatchObject({ status: "finished", homeGoals: 2, awayGoals: 1 });
    await t.db.update(seasons).set({ status: "closed", closedAt: after(REGISTERED, 90) }).where(eq(seasons.id, s2.seasonId));
  });

  async function subjectOf(userId: string): Promise<string | undefined> {
    const { rows } = await t.db.execute(sql`select subject from futbolsa.auth_identities where user_id = ${userId}`);
    return rows[0] ? String(rows[0].subject) : undefined;
  }
});
