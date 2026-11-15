import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CLUBS, type PayoutEvent } from "@futbolsa/engine";
import { FixedClock } from "../../src/infra/clock/index.js";
import { DB, type Database, lockWallets, type Tx, withTransaction } from "../../src/infra/db/index.js";
import { clubs, matches, payoutCredits, payoutEvents, payoutHoldings, seasons, wallets } from "../../src/infra/db/schema/index.js";
import type { RefreshReason } from "../../src/infra/db/schema/values.js";
import { post } from "../../src/modules/portfolio/ledger/index.js";
import { EngineInputService } from "../../src/modules/admin/payouts/engine-input.js";
import {
  CLOSE_MARGIN_MS,
  CloseEventsService,
  DIVIDEND_EVENTS,
} from "../../src/modules/admin/payouts/close-events.service.js";
import { type PayoutsChange, RankingsPort } from "../../src/modules/admin/payouts/ports.js";
import { MarketPort, MatchesEvents } from "../../src/modules/admin/results/ports.js";
import { StandingsService } from "../../src/modules/admin/standings/standings.service.js";
import { SeasonValuesService } from "../../src/modules/dividends/season-values/season-values.service.js";
import { createTestApp } from "../support/app.js";
import { withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { createUser, listClubs, openPlayerWallets, openWallets, seedSeason, T0 } from "../support/fixtures.js";

const MIN = 60_000;
const TOTAL = 10_000;
/** Todos os clubes do seed menos JUV3 e RBB3, que ficam fora da lista da temporada. */
const UNLISTED = ["JUV3", "RBB3"];
const LISTED = CLUBS.map((c) => c.id).filter((t) => !UNLISTED.includes(t));
const ANA_SHARES = 1_000;
const BRUNO_SHARES = 400;
/** Preço de R$ 1,00 por ação nos negócios de teste (o caixa inicial cobre as compras de todos os clubes). */
const PRICE = 100;

/** Um horário (UTC) de 2027. */
const at = (iso: string) => new Date(iso);

/** Tabela onde as portas de teste gravam pelo `tx` que recebem: some se a transação desfaz. */
const CALLS = sql.raw("public.test_port_calls");

/** O `MarketPort` de teste: grava cada pedido de reposição (e numa tabela, pelo `tx`) e pode falhar de propósito. */
class RecordingMarket extends MarketPort {
  readonly refreshes: Array<{ tickers: string[]; reason: RefreshReason }> = [];
  failFor: string | null = null;

  async cancelHouseQuotes(): Promise<void> {}

  async requestRefresh(tx: Tx, tickers: readonly string[], reason: RefreshReason): Promise<void> {
    if (this.failFor && tickers.includes(this.failFor)) throw new Error(`falha de teste no pedido de reposição de ${this.failFor}`);
    this.refreshes.push({ tickers: [...tickers], reason });
    await tx.db.execute(sql`insert into ${CALLS} (port, payload) values ('market', ${JSON.stringify({ tickers, reason })}::jsonb)`);
  }
}

/** O `RankingsPort` de teste: grava o aviso pelo `tx` e, no `wake()`, quantos avisos já se veem de fora. */
class RecordingRankings extends RankingsPort {
  readonly changes: PayoutsChange[] = [];
  /** Em cada `wake()`: os avisos gravados até ali e os que outra conexão já vê (com `COMMIT`). */
  readonly wakes: Array<{ recorded: number; visible: number }> = [];
  db!: Database;

  async payoutsChanged(tx: Tx, change: PayoutsChange): Promise<void> {
    this.changes.push(change);
    await tx.db.execute(
      sql`insert into ${CALLS} (port, season_id, payload) values ('rankings', ${change.seasonId}, ${JSON.stringify(change.closedAts.map((d) => d.toISOString()))}::jsonb)`,
    );
  }

  async wake(): Promise<void> {
    const { rows } = await this.db.execute(sql`select count(*)::int as n from ${CALLS} where port = 'rankings'`);
    this.wakes.push({ recorded: this.changes.length, visible: Number(rows[0]!.n) });
  }
}

describe("fechamento dos eventos de pagamento (closeEvents)", () => {
  const t = useTestDatabase(10);
  const clock = new FixedClock(T0);
  const market = new RecordingMarket();
  const rankings = new RecordingRankings();
  let app: NestFastifyApplication;
  let service: CloseEventsService;
  let clubIds: Map<string, number>;
  /** Clubes sem ticker (de fora da lista, como os da Série B), para os adversários das copas e a tabela da B. */
  let outsiders: number[];
  let year = 2030;

  beforeAll(async () => {
    rankings.db = t.db;
    await t.db.execute(sql`create table ${CALLS} (id serial primary key, port text not null, season_id int, payload jsonb)`);
    app = await createTestApp({
      db: t.db,
      clock,
      override: (b) => withTestAuth(clock)(b).overrideProvider(MarketPort).useValue(market).overrideProvider(RankingsPort).useValue(rankings),
    });
    service = app.get(CloseEventsService, { strict: false });
    ({ clubIds } = await seedSeason(t.db, 2029));
    outsiders = (
      await t.db
        .insert(clubs)
        .values(Array.from({ length: 6 }, (_, i) => ({ name: `Clube de fora ${i + 1}` })))
        .returning({ id: clubs.id })
    ).map((r) => r.id);
  });
  afterAll(() => app?.close());
  beforeEach(async () => {
    market.refreshes.length = 0;
    market.failFor = null;
    rankings.changes.length = 0;
    rankings.wakes.length = 0;
    await t.db.execute(sql`delete from ${CALLS}`);
  });

  const club = (ticker: string) => clubIds.get(ticker)!;

  interface Season {
    seasonId: number;
    treasury: number;
    ana: number;
    bruno: number;
  }

  /**
   * Uma temporada nova (cada teste a sua, porque a foto e os eventos são histórico imutável): os 18 clubes
   * listados, os valores padrão, a tesouraria com as ações e Ana (1.000) e Bruno (400) com ações de cada clube,
   * compradas antes de qualquer jogo, montadas pelo `portfolio.post` direto (P1).
   */
  async function newSeason(): Promise<Season> {
    const { seasonId } = await seedSeason(t.db, year++);
    await listClubs(t.db, seasonId, clubIds, LISTED, TOTAL);
    const values = app.get(SeasonValuesService, { strict: false });
    await withTransaction(t.db, (tx) => values.createInitial(tx, seasonId).then(() => undefined));
    const [treasury] = await openWallets(t.db, seasonId, [{ type: "treasury" }]);
    const [ana, bruno] = await openPlayerWallets(t.db, seasonId, 2);
    await withTransaction(t.db, async (tx) => {
      await lockWallets(tx, [ana!, bruno!, treasury!]);
      for (const ticker of LISTED) {
        const clubId = club(ticker);
        await post(tx, { walletId: treasury!, at: T0, kind: "adjustment", clubId, sharesDelta: TOTAL, price: 4000, costBasis: "purchase", reason: "emissão" });
        for (const [walletId, shares] of [[ana!, ANA_SHARES], [bruno!, BRUNO_SHARES]] as const) {
          await post(tx, { walletId: treasury!, at: T0, kind: "trade", clubId, sharesDelta: -shares, cashDelta: shares * PRICE, price: PRICE, costBasis: "sale" });
          await post(tx, { walletId, at: T0, kind: "trade", clubId, sharesDelta: shares, cashDelta: -shares * PRICE, price: PRICE, costBasis: "purchase" });
        }
      }
    });
    return { seasonId, treasury: treasury!, ana: ana!, bruno: bruno! };
  }

  /** Ana passa ações a Bruno no instante dado (pelo extrato, como um negócio). */
  async function trade(s: Season, ticker: string, shares: number, when: Date) {
    await withTransaction(t.db, async (tx) => {
      await lockWallets(tx, [s.ana, s.bruno]);
      await post(tx, { walletId: s.ana, at: when, kind: "trade", clubId: club(ticker), sharesDelta: -shares, cashDelta: shares * PRICE, price: PRICE, costBasis: "sale" });
      await post(tx, { walletId: s.bruno, at: when, kind: "trade", clubId: club(ticker), sharesDelta: shares, cashDelta: -shares * PRICE, price: PRICE, costBasis: "purchase" });
    });
  }

  type MatchInsert = typeof matches.$inferInsert;
  /** Um jogo de liga terminado (ou ainda sem placar), com o fim explícito = início + 2 h. */
  const game = (
    seasonId: number,
    round: number,
    home: string | number,
    away: string | number,
    score: [number, number] | null,
    kickoff: Date,
    extra: Partial<MatchInsert> = {},
  ): MatchInsert => ({
    seasonId,
    competition: "brasileirao-a",
    round,
    homeClubId: typeof home === "number" ? home : club(home),
    awayClubId: typeof away === "number" ? away : club(away),
    kickoff,
    finishedAt: score ? new Date(kickoff.getTime() + 120 * MIN) : null,
    homeGoals: score ? score[0] : null,
    awayGoals: score ? score[1] : null,
    status: score ? "finished" : "scheduled",
    ...extra,
  });
  /** Um jogo de copa às 21h30 de Brasília (00h30 UTC do dia seguinte), como nos testes do motor. */
  const cupGame = (
    seasonId: number,
    competition: string,
    phase: string,
    day: string,
    home: string | number,
    away: string | number,
    score: [number, number] | null,
    extra: Partial<MatchInsert> = {},
  ): MatchInsert => ({
    ...game(seasonId, 0, home, away, score, at(`${day}T21:30:00-03:00`), extra),
    competition,
    round: null,
    phase,
  });

  const insertMatches = async (rows: MatchInsert[]) => t.db.insert(matches).values(rows).returning();

  /** A rodada 10 do critério 1 do admin: 10 jogos, o último terminando às 20h (UTC) de 06/06/2027. */
  const ROUND10_CLOSE = at("2027-06-06T20:00:00Z");
  const round10 = (seasonId: number): MatchInsert[] => {
    const pairs: Array<[string, string, [number, number]]> = [
      ["FLA3", "PAL3", [2, 0]],
      ["CAM3", "BOT3", [2, 1]],
      ["COR3", "SAO3", [1, 1]],
      ["FLU3", "VAS3", [0, 1]],
      ["SAN3", "GRE3", [3, 0]],
      ["INT3", "CRU3", [0, 0]],
      ["BAH3", "FOR3", [1, 2]],
      ["CEA3", "SPT3", [2, 2]],
      ["VIT3", "MIR3", [1, 0]],
      ["JUV3", "RBB3", [0, 0]],
    ];
    return pairs.map(([home, away, score], i) =>
      // começos entre 16h e 18h: o último (JUV3 × RBB3) termina às 20h
      game(seasonId, 10, home, away, score, new Date(ROUND10_CLOSE.getTime() - 120 * MIN - (9 - i) * 10 * MIN)),
    );
  };
  /** Os clubes listados que pontuam na rodada 10, com o valor por ação (R$ 0,10 por ponto). */
  const ROUND10_EVENTS: Record<string, number> = {
    FLA3: 30, CAM3: 30, COR3: 10, SAO3: 10, VAS3: 30, SAN3: 30, INT3: 10, CRU3: 10, FOR3: 30, CEA3: 10, SPT3: 10, VIT3: 30,
  };

  const eventsOf = (seasonId: number) =>
    t.db.select().from(payoutEvents).where(eq(payoutEvents.seasonId, seasonId)).orderBy(asc(payoutEvents.id));
  const currentOf = async (seasonId: number) =>
    (await eventsOf(seasonId)).filter((e) => e.status !== "superseded");
  const eventOf = async (seasonId: number, ticker: string, status?: string) =>
    (await eventsOf(seasonId)).filter((e) => e.clubId === club(ticker) && (status === undefined || e.status === status));
  const photoOf = async (eventId: number) =>
    Object.fromEntries(
      (await t.db.select().from(payoutHoldings).where(eq(payoutHoldings.eventId, eventId))).map((h) => [h.walletId, h.shares]),
    );
  const close = (seasonId: number, now: Date) => {
    clock.set(now);
    return service.closeEvents(seasonId, now);
  };
  const portRows = async (port: string) =>
    (await t.db.execute(sql`select payload from ${CALLS} where port = ${port} order by id`)).rows.map((r) => r.payload);
  const cashOf = async (seasonId: number) =>
    (await t.db.select({ id: wallets.id, cash: wallets.cash }).from(wallets).where(eq(wallets.seasonId, seasonId))).sort((a, b) => a.id - b.id);

  const after = (d: Date, minutes: number) => new Date(d.getTime() + minutes * MIN);

  it("admin 1: a rodada fecha às 20h com um pagamento aguardando e nenhum crédito", async () => {
    const s = await newSeason();
    await insertMatches(round10(s.seasonId));
    // uma venda às 20h01, depois do fechamento, não muda quem recebe
    await trade(s, "FLA3", 100, after(ROUND10_CLOSE, 1));
    const cashBefore = await cashOf(s.seasonId);

    const summary = await close(s.seasonId, after(ROUND10_CLOSE, 3));
    expect(summary).toMatchObject({ created: 12, versioned: 0, superseded: 0, deferred: 0, errors: [] });

    const events = await eventsOf(s.seasonId);
    expect(Object.fromEntries(events.map((e) => [LISTED.find((tk) => club(tk) === e.clubId), e.perShare]))).toEqual(ROUND10_EVENTS);
    for (const e of events) {
      expect(e).toMatchObject({
        status: "pending",
        version: 1,
        supersedesId: null,
        kind: "points",
        competition: "brasileirao-a",
        round: 10,
        phase: null,
        closedAt: ROUND10_CLOSE,
        approvedAt: null,
        createdAt: after(ROUND10_CLOSE, 3),
      });
      expect(await photoOf(e.id)).toEqual({ [s.ana]: ANA_SHARES, [s.bruno]: BRUNO_SHARES });
    }
    const fla = (await eventOf(s.seasonId, "FLA3"))[0]!;
    expect(fla).toMatchObject({ eventKey: "points|brasileirao-a|10|FLA3", reason: "3 pontos, rodada 10", perShare: 30 });
    // nada cai no caixa
    expect(await t.db.select().from(payoutCredits)).toEqual([]);
    expect(await cashOf(s.seasonId)).toEqual(cashBefore);
  });

  it("admin 11: corrigir o placar com o pagamento pendente só refaz a prévia", async () => {
    const s = await newSeason();
    const [, camBot] = await insertMatches(round10(s.seasonId));
    await close(s.seasonId, after(ROUND10_CLOSE, 3));
    const v1 = (await eventOf(s.seasonId, "CAM3"))[0]!;

    // CAM3 × BOT3 de 2 × 1 para 1 × 1: CAM3 cai para 1 ponto e BOT3 passa a ter 1 ponto
    await t.db.update(matches).set({ homeGoals: 1, awayGoals: 1 }).where(eq(matches.id, camBot!.id));
    const summary = await close(s.seasonId, after(ROUND10_CLOSE, 10));
    expect(summary).toMatchObject({ created: 1, versioned: 1, superseded: 0, errors: [] });

    const cam = await eventOf(s.seasonId, "CAM3");
    expect(cam).toHaveLength(2);
    expect(cam[0]).toMatchObject({ id: v1.id, status: "superseded", version: 1, perShare: 30 });
    expect(cam[1]).toMatchObject({
      status: "pending",
      version: 2,
      supersedesId: v1.id,
      perShare: 10,
      reason: "1 ponto, rodada 10",
      closedAt: ROUND10_CLOSE,
      eventKey: v1.eventKey,
    });
    // o fechamento não mudou: a foto é a mesma, copiada
    expect(await photoOf(cam[1]!.id)).toEqual(await photoOf(v1.id));
    expect(await eventOf(s.seasonId, "BOT3")).toEqual([expect.objectContaining({ status: "pending", version: 1, perShare: 10 })]);
    expect(await t.db.select().from(payoutCredits)).toEqual([]);
  });

  it("admin 11: com o fechamento mudado, a versão nova tira a foto de novo no fechamento novo", async () => {
    const s = await newSeason();
    const rows = await insertMatches(round10(s.seasonId));
    await close(s.seasonId, after(ROUND10_CLOSE, 3));
    const v1 = (await eventOf(s.seasonId, "FLA3"))[0]!;
    // Ana vende 100 FLA3 às 20h10; depois o último jogo da rodada é corrigido para terminar às 20h30
    await trade(s, "FLA3", 100, after(ROUND10_CLOSE, 10));
    const last = rows[rows.length - 1]!;
    await t.db.update(matches).set({ finishedAt: after(ROUND10_CLOSE, 30) }).where(eq(matches.id, last.id));
    rankings.changes.length = 0;

    const summary = await close(s.seasonId, after(ROUND10_CLOSE, 40));
    expect(summary).toMatchObject({ created: 0, versioned: 12, superseded: 0, errors: [] });
    const fla = await eventOf(s.seasonId, "FLA3");
    expect(fla[1]).toMatchObject({ status: "pending", version: 2, supersedesId: v1.id, closedAt: after(ROUND10_CLOSE, 30), perShare: 30 });
    expect(await photoOf(v1.id)).toEqual({ [s.ana]: ANA_SHARES, [s.bruno]: BRUNO_SHARES });
    expect(await photoOf(fla[1]!.id)).toEqual({ [s.ana]: ANA_SHARES - 100, [s.bruno]: BRUNO_SHARES + 100 });
    // o aviso aos rankings leva o fechamento antigo e o novo
    expect(rankings.changes).toHaveLength(12);
    for (const change of rankings.changes) {
      expect(change.seasonId).toBe(s.seasonId);
      expect(change.closedAts.map((d) => d.getTime()).sort()).toEqual([ROUND10_CLOSE.getTime(), after(ROUND10_CLOSE, 30).getTime()]);
    }
  });

  it("rodar a passada duas vezes seguidas não grava nada na segunda", async () => {
    const s = await newSeason();
    await insertMatches(round10(s.seasonId));
    await close(s.seasonId, after(ROUND10_CLOSE, 3));
    const first = await eventsOf(s.seasonId);
    const holdings = await t.db.select({ n: sql<number>`count(*)::int` }).from(payoutHoldings);
    market.refreshes.length = 0;
    rankings.changes.length = 0;
    rankings.wakes.length = 0;

    const summary = await close(s.seasonId, after(ROUND10_CLOSE, 5));
    expect(summary).toMatchObject({ created: 0, versioned: 0, superseded: 0, deferred: 0, errors: [] });
    expect(await eventsOf(s.seasonId)).toEqual(first);
    expect(await t.db.select({ n: sql<number>`count(*)::int` }).from(payoutHoldings)).toEqual(holdings);
    // passada que nada muda não avisa ninguém
    expect(market.refreshes).toEqual([]);
    expect(rankings.changes).toEqual([]);
    expect(rankings.wakes).toEqual([]);
  });

  it("duas passadas ao mesmo tempo dão um evento só (mesma API: uma por vez por temporada)", async () => {
    const s = await newSeason();
    await insertMatches(round10(s.seasonId));
    clock.set(after(ROUND10_CLOSE, 3));
    const [a, b] = await Promise.all([
      service.closeEvents(s.seasonId, after(ROUND10_CLOSE, 3)),
      service.closeEvents(s.seasonId, after(ROUND10_CLOSE, 3)),
    ]);
    expect(a.created + b.created).toBe(12);
    expect([...a.errors, ...b.errors]).toEqual([]);
    const events = await eventsOf(s.seasonId);
    expect(events).toHaveLength(12);
    for (const e of events) expect(Object.keys(await photoOf(e.id))).toHaveLength(2);
    expect(rankings.changes).toHaveLength(12);
  });

  it("duas passadas ao mesmo tempo em instâncias diferentes dão um evento só (a rede do banco)", async () => {
    const s = await newSeason();
    await insertMatches(round10(s.seasonId));
    clock.set(after(ROUND10_CLOSE, 3));
    const db = app.get<Database>(DB, { strict: false });
    const engine = app.get(EngineInputService, { strict: false });
    const one = new CloseEventsService(db, engine, market, rankings);
    const two = new CloseEventsService(db, engine, market, rankings);
    const results = await Promise.all([one.closeEvents(s.seasonId, after(ROUND10_CLOSE, 3)), two.closeEvents(s.seasonId, after(ROUND10_CLOSE, 3))]);
    expect(results.flatMap((r) => r.errors)).toEqual([]);
    expect(results[0]!.created + results[1]!.created).toBe(12);
    const events = await eventsOf(s.seasonId);
    expect(events).toHaveLength(12);
    for (const e of events) expect(await photoOf(e.id)).toEqual({ [s.ana]: ANA_SHARES, [s.bruno]: BRUNO_SHARES });
    // quem perdeu a corrida não avisa nem pede reposição
    expect(rankings.changes).toHaveLength(12);
    expect(market.refreshes).toHaveLength(12);

    // e a troca de versão ao mesmo tempo também: uma versão 2 só
    await t.db
      .update(matches)
      .set({ homeGoals: 1, awayGoals: 1 })
      .where(and(eq(matches.seasonId, s.seasonId), eq(matches.homeClubId, club("CAM3"))));
    await Promise.all([one.closeEvents(s.seasonId, after(ROUND10_CLOSE, 9)), two.closeEvents(s.seasonId, after(ROUND10_CLOSE, 9))]);
    const cam = await eventOf(s.seasonId, "CAM3");
    expect(cam.map((e) => [e.version, e.status])).toEqual([
      [1, "superseded"],
      [2, "pending"],
    ]);
    expect(await eventOf(s.seasonId, "BOT3")).toHaveLength(1);
  });

  it("fechamento a 1 minuto do relógio não gera evento e a 3 minutos gera (margem de 2 minutos, P8)", async () => {
    expect(CLOSE_MARGIN_MS).toBe(2 * MIN);
    const s = await newSeason();
    await insertMatches(round10(s.seasonId));
    expect(await close(s.seasonId, after(ROUND10_CLOSE, 1))).toMatchObject({ created: 0 });
    expect(await eventsOf(s.seasonId)).toEqual([]);
    expect(rankings.changes).toEqual([]);
    expect(await close(s.seasonId, after(ROUND10_CLOSE, 3))).toMatchObject({ created: 12 });
    expect(await eventsOf(s.seasonId)).toHaveLength(12);
  });

  it("pending que some do resultado vira superseded, sem substituto", async () => {
    const s = await newSeason();
    const [flaPal] = await insertMatches(round10(s.seasonId));
    await close(s.seasonId, after(ROUND10_CLOSE, 3));
    const fla = (await eventOf(s.seasonId, "FLA3"))[0]!;
    rankings.changes.length = 0;
    market.refreshes.length = 0;

    // FLA3 × PAL3 de 2 × 0 para 0 × 2: FLA3 não pontua mais; PAL3 passa a pontuar
    await t.db.update(matches).set({ homeGoals: 0, awayGoals: 2 }).where(eq(matches.id, flaPal!.id));
    const summary = await close(s.seasonId, after(ROUND10_CLOSE, 10));
    expect(summary).toMatchObject({ created: 1, versioned: 0, superseded: 1, errors: [] });
    expect(await eventOf(s.seasonId, "FLA3")).toEqual([expect.objectContaining({ id: fla.id, status: "superseded", version: 1 })]);
    const successors = await t.db.select().from(payoutEvents).where(eq(payoutEvents.supersedesId, fla.id));
    expect(successors).toEqual([]);
    expect(await eventOf(s.seasonId, "PAL3")).toEqual([expect.objectContaining({ status: "pending", perShare: 30 })]);
    // substituído também avisa os rankings, com o fechamento dele
    expect(rankings.changes.map((c) => c.closedAts.map((d) => d.getTime()))).toEqual([[ROUND10_CLOSE.getTime()], [ROUND10_CLOSE.getTime()]]);
    expect(market.refreshes.map((r) => r.tickers).sort()).toEqual([["FLA3"], ["PAL3"]]);
  });

  it("evento approved que muda ou some não é tocado, e evento novo no grupo já aprovado não é gravado (fica para a correção)", async () => {
    const s = await newSeason();
    const [flaPal, camBot] = await insertMatches(round10(s.seasonId));
    await close(s.seasonId, after(ROUND10_CLOSE, 3));
    // o admin aprovou o CAM3 (à mão aqui; a aprovação é da T5)
    const cam = (await eventOf(s.seasonId, "CAM3"))[0]!;
    const fla = (await eventOf(s.seasonId, "FLA3"))[0]!;
    await t.db.update(payoutEvents).set({ status: "approved", approvedAt: after(ROUND10_CLOSE, 4) }).where(inArray(payoutEvents.id, [cam.id, fla.id]));
    rankings.changes.length = 0;
    market.refreshes.length = 0;

    // CAM3 × BOT3 vira 1 × 1 (o aprovado muda e BOT3 nasce no grupo aprovado); FLA3 × PAL3 vira 0 × 0 (FLA3 aprovado muda; PAL3 nasce)
    await t.db.update(matches).set({ homeGoals: 1, awayGoals: 1 }).where(eq(matches.id, camBot!.id));
    await t.db.update(matches).set({ homeGoals: 0, awayGoals: 0 }).where(eq(matches.id, flaPal!.id));
    const summary = await close(s.seasonId, after(ROUND10_CLOSE, 10));
    expect(summary).toMatchObject({ created: 0, versioned: 0, superseded: 0, deferred: 2, errors: [] });
    expect(await eventOf(s.seasonId, "CAM3")).toEqual([expect.objectContaining({ id: cam.id, status: "approved", version: 1, perShare: 30 })]);
    expect(await eventOf(s.seasonId, "BOT3")).toEqual([]);
    expect(await eventOf(s.seasonId, "PAL3")).toEqual([]);
    expect(rankings.changes).toEqual([]);
    expect(market.refreshes).toEqual([]);

    // aprovado que some (CAM3 perde) também fica como está
    await t.db.update(matches).set({ homeGoals: 0, awayGoals: 1 }).where(eq(matches.id, camBot!.id));
    await close(s.seasonId, after(ROUND10_CLOSE, 12));
    expect(await eventOf(s.seasonId, "CAM3")).toEqual([expect.objectContaining({ id: cam.id, status: "approved", perShare: 30 })]);

    // num grupo ainda sem aprovação (a rodada 11), o evento novo vira pending
    const r11 = at("2027-06-13T21:00:00Z");
    await insertMatches([game(s.seasonId, 11, "BOT3", "CAM3", [1, 0], r11)]);
    await close(s.seasonId, after(r11, 125));
    expect(await eventOf(s.seasonId, "BOT3")).toEqual([expect.objectContaining({ status: "pending", round: 11, perShare: 30 })]);
  });

  it("o tipo buyback é ignorado: nem gravado nem substituído", async () => {
    expect(DIVIDEND_EVENTS.kinds).not.toContain("buyback");
    const s = await newSeason();
    await insertMatches(round10(s.seasonId));
    // um buyback pendente que já estivesse gravado (o da F15) não é substituído pela passada
    const [old] = await t.db
      .insert(payoutEvents)
      .values({
        seasonId: s.seasonId,
        clubId: club("GRE3"),
        eventKey: "buyback|temporada|fim|GRE3",
        kind: "buyback",
        reason: "recompra",
        perShare: 100,
        closedAt: ROUND10_CLOSE,
        createdAt: ROUND10_CLOSE,
      })
      .returning();
    // uma fonte que também trouxesse um evento de recompra sem ser dona do tipo: ele fica de fora
    const fake: PayoutEvent = {
      key: "buyback|temporada|fim|FLA3",
      kind: "buyback",
      clubId: "FLA3",
      competition: "brasileirao-a",
      stage: "fim",
      perShare: 999,
      closedAt: ROUND10_CLOSE.getTime(),
      reason: "recompra",
    };
    const db = app.get<Database>(DB, { strict: false });
    const other = new CloseEventsService(db, app.get(EngineInputService, { strict: false }), market, rankings);
    other.registerSource({ name: "teste", kinds: [], events: () => [fake] });
    const summary = await other.closeEvents(s.seasonId, after(ROUND10_CLOSE, 3));
    expect(summary).toMatchObject({ errors: [] });
    const kinds = (await eventsOf(s.seasonId)).map((e) => e.kind);
    expect(kinds.filter((k) => k === "points")).toHaveLength(12);
    expect(await eventOf(s.seasonId, "FLA3")).toEqual([expect.objectContaining({ kind: "points" })]);
    expect(await eventOf(s.seasonId, "GRE3")).toEqual([expect.objectContaining({ id: old!.id, kind: "buyback", status: "pending" })]);
  });

  it("o pedido de reposição do formador (close) sai na mesma transação, com os tickers de cada clube", async () => {
    const s = await newSeason();
    await insertMatches(round10(s.seasonId));
    await close(s.seasonId, after(ROUND10_CLOSE, 3));
    expect(market.refreshes.every((r) => r.reason === "close")).toBe(true);
    expect(market.refreshes.map((r) => r.tickers).sort()).toEqual(Object.keys(ROUND10_EVENTS).sort().map((tk) => [tk]));
    expect((await portRows("market")).length).toBe(12);
  });

  it("a transação que desfaz leva o evento, a foto e o aviso aos rankings junto, e o wake() não roda", async () => {
    const s = await newSeason();
    await insertMatches(round10(s.seasonId));
    market.failFor = "FLA3";
    const summary = await close(s.seasonId, after(ROUND10_CLOSE, 3));
    expect(summary.created).toBe(11);
    expect(summary.errors).toEqual([expect.stringContaining("FLA3")]);
    expect(await eventOf(s.seasonId, "FLA3")).toEqual([]);
    // o aviso do FLA3 foi chamado, mas desfez junto com a transação
    expect(rankings.changes).toHaveLength(12);
    expect(await portRows("rankings")).toHaveLength(11);
    expect(rankings.wakes).toHaveLength(11);

    // a passada seguinte grava o que faltou
    market.failFor = null;
    expect(await close(s.seasonId, after(ROUND10_CLOSE, 4))).toMatchObject({ created: 1, errors: [] });
    expect(await eventOf(s.seasonId, "FLA3")).toHaveLength(1);
  });

  it("o aviso aos rankings: nasce avisa com o fechamento, e o wake() só roda depois do COMMIT", async () => {
    const s = await newSeason();
    await insertMatches(round10(s.seasonId));
    await close(s.seasonId, after(ROUND10_CLOSE, 3));
    expect(rankings.changes).toHaveLength(12);
    for (const c of rankings.changes) {
      expect(c).toEqual({ seasonId: s.seasonId, closedAts: [ROUND10_CLOSE] });
    }
    expect(await portRows("rankings")).toHaveLength(12);
    // em cada wake(), outra conexão já via todos os avisos gravados até ali: o COMMIT veio antes
    expect(rankings.wakes).toHaveLength(12);
    for (const w of rankings.wakes) expect(w.visible).toBe(w.recorded);
  });

  it("evento que nasce depois de o mês fechar avisa com o fechamento dele", async () => {
    const s = await newSeason();
    await insertMatches(round10(s.seasonId));
    // a passada só roda em julho (a API ficou fora): o fechamento é o de junho
    await close(s.seasonId, at("2027-07-02T12:00:00Z"));
    expect(rankings.changes).toHaveLength(12);
    expect(rankings.changes.every((c) => c.closedAts.length === 1 && c.closedAts[0]!.getTime() === ROUND10_CLOSE.getTime())).toBe(true);
    expect((await eventsOf(s.seasonId)).every((e) => e.closedAt.getTime() === ROUND10_CLOSE.getTime())).toBe(true);
  });

  it("temporada encerrada: a passada não faz nada", async () => {
    const s = await newSeason();
    await insertMatches(round10(s.seasonId));
    await t.db.update(seasons).set({ status: "closed" }).where(eq(seasons.id, s.seasonId));
    expect(await close(s.seasonId, after(ROUND10_CLOSE, 3))).toMatchObject({ created: 0, versioned: 0, superseded: 0, errors: [] });
    expect(await eventsOf(s.seasonId)).toEqual([]);
  });

  describe("Dividendos e recompra, de ponta a ponta (jogos → eventos gravados)", () => {
    it("div 1: vitória do FLA3 na rodada 5 fica aguardando com R$ 0,30 por ação e o motivo '3 pontos, rodada 5'", async () => {
      const s = await newSeason();
      await insertMatches([
        game(s.seasonId, 5, "FLA3", "PAL3", [2, 0], at("2027-05-09T16:00:00-03:00")),
        game(s.seasonId, 5, "COR3", "SAO3", [0, 0], at("2027-05-09T18:30:00-03:00")),
      ]);
      await close(s.seasonId, at("2027-05-09T21:00:00-03:00"));
      expect(await eventOf(s.seasonId, "FLA3")).toEqual([
        expect.objectContaining({
          kind: "points",
          status: "pending",
          perShare: 30,
          reason: "3 pontos, rodada 5",
          round: 5,
          closedAt: at("2027-05-09T20:30:00-03:00"),
        }),
      ]);
      expect(await eventOf(s.seasonId, "PAL3")).toEqual([]);
    });

    it("div 4: rodada com 9 jogos terminados e o 10º por terminar (não adiado) não fecha e ninguém recebe", async () => {
      const s = await newSeason();
      const rows = round10(s.seasonId);
      rows[9] = game(s.seasonId, 10, "JUV3", "RBB3", null, at("2027-06-07T19:00:00Z"));
      await insertMatches(rows);
      expect(rows.filter((r) => r.status === "finished")).toHaveLength(9);
      // depois do fim do 9º jogo, e mesmo depois do fim previsto dos que faltam
      await close(s.seasonId, at("2027-06-08T12:00:00Z"));
      expect(await eventsOf(s.seasonId)).toEqual([]);
    });

    it("div 5: o jogo adiado da rodada 12 paga no fechamento da rodada 16 ('6 pontos, rodada 16, 12 (adiado)')", async () => {
      const s = await newSeason();
      await insertMatches([
        game(s.seasonId, 12, "FLA3", "COR3", [2, 0], at("2027-07-20T16:00:00-03:00"), { outOfWindow: true }),
        game(s.seasonId, 16, "FLA3", "SAO3", [1, 0], at("2027-07-21T16:00:00-03:00")),
      ]);
      await close(s.seasonId, at("2027-07-21T19:00:00-03:00"));
      expect(await eventOf(s.seasonId, "FLA3")).toEqual([
        expect.objectContaining({
          perShare: 60,
          reason: "6 pontos, rodada 16, 12 (adiado)",
          round: 16,
          closedAt: at("2027-07-21T18:00:00-03:00"),
        }),
      ]);
    });

    it("div 6: o adiado disputado depois da última rodada paga os pontos e a colocação no fim dele", async () => {
      const s = await newSeason();
      await insertMatches([
        game(s.seasonId, 38, "PAL3", "COR3", [0, 0], at("2027-12-05T16:00:00-03:00")),
        game(s.seasonId, 30, "FLA3", "SAO3", null, at("2027-12-12T16:00:00-03:00"), { status: "postponed" }),
      ]);
      await importTable(s.seasonId, "brasileirao-a", ["FLA3", "PAL3", "COR3", "SAO3"].map(club));
      // depois da última rodada, com o adiado ainda por jogar: só os pontos da rodada 38, sem colocação
      await close(s.seasonId, at("2027-12-06T12:00:00Z"));
      expect((await eventsOf(s.seasonId)).map((e) => e.kind)).toEqual(["points", "points"]);

      await t.db
        .update(matches)
        .set({ status: "finished", outOfWindow: true, homeGoals: 1, awayGoals: 0, finishedAt: at("2027-12-12T18:00:00-03:00") })
        .where(and(eq(matches.seasonId, s.seasonId), eq(matches.round, 30)));
      await close(s.seasonId, at("2027-12-12T19:00:00-03:00"));
      const fimDoJogo = at("2027-12-12T18:00:00-03:00");
      const fla = await eventOf(s.seasonId, "FLA3");
      expect(fla.map((e) => [e.kind, e.closedAt, e.round, e.phase]).sort()).toEqual([
        ["placement", fimDoJogo, null, null],
        ["points", fimDoJogo, null, null],
      ]);
      expect(fla.find((e) => e.kind === "placement")).toMatchObject({ perShare: 500, eventKey: "placement|brasileirao-a|fim|FLA3" });
      expect(fla.find((e) => e.kind === "points")).toMatchObject({ perShare: 30, eventKey: "points|brasileirao-a|fim|FLA3" });
      const placements = (await eventsOf(s.seasonId)).filter((e) => e.kind === "placement");
      expect(placements.every((e) => e.closedAt.getTime() === fimDoJogo.getTime())).toBe(true);
    });

    it("div 7: BOT3 em 1º recebe R$ 5,00, CEA3 em 16º R$ 0,20 e SPT3 em 17º nada", async () => {
      const s = await newSeason();
      await insertMatches([game(s.seasonId, 38, "BOT3", "CEA3", [1, 0], at("2027-12-05T16:00:00-03:00"))]);
      // a tabela tem 20 clubes: com os promovidos de 2026 a lista de clubes conhecidos passou de 20, então só os 17 primeiros entram
      const others = CLUBS.map((c) => c.id).filter((tk) => !["BOT3", "CEA3", "SPT3"].includes(tk)).slice(0, 17);
      const order = ["BOT3", ...others.slice(0, 14), "CEA3", "SPT3", ...others.slice(14)];
      expect(order).toHaveLength(20);
      await importTable(s.seasonId, "brasileirao-a", order.map(club));
      await close(s.seasonId, at("2027-12-05T19:00:00-03:00"));
      const placement = Object.fromEntries(
        (await eventsOf(s.seasonId)).filter((e) => e.kind === "placement").map((e) => [CLUBS.find((c) => club(c.id) === e.clubId)!.id, e]),
      );
      expect(placement.BOT3).toMatchObject({ perShare: 500, reason: "1º lugar", status: "pending" });
      expect(placement.CEA3).toMatchObject({ perShare: 20, reason: "16º lugar" });
      expect(placement.SPT3).toBeUndefined();
    });

    it("div 9: GRE3 em 3º na Série B recebe R$ 2,00 de acesso e VAS3 em 5º nada", async () => {
      const s = await newSeason();
      await insertMatches([
        { ...game(s.seasonId, 38, "GRE3", "VAS3", [1, 0], at("2027-11-28T16:00:00-03:00")), competition: "brasileirao-b" },
      ]);
      const [nl1, nl2, nl3, nl4] = outsiders;
      await importTable(s.seasonId, "brasileirao-b", [nl1!, nl2!, club("GRE3"), nl3!, club("VAS3"), nl4!]);
      await close(s.seasonId, at("2027-11-28T19:00:00-03:00"));
      const promotion = (await eventsOf(s.seasonId)).filter((e) => e.kind === "promotion");
      expect(promotion).toEqual([
        expect.objectContaining({
          clubId: club("GRE3"),
          perShare: 200,
          competition: "brasileirao-b",
          round: null,
          phase: null,
          reason: "acesso à Série A: 3º na Série B",
        }),
      ]);
      // e os pontos da vitória na B: R$ 0,05 por ponto
      expect(await eventOf(s.seasonId, "GRE3")).toContainEqual(expect.objectContaining({ kind: "points", perShare: 15, round: 38 }));
    });

    it("div 12: ida e volta só paga depois do último jogo de volta da fase (R$ 3,75 ao PAL3)", async () => {
      const s = await newSeason();
      const [x1, x2, x3] = outsiders;
      const lib = "libertadores";
      const [, , , lastLeg] = await insertMatches([
        cupGame(s.seasonId, lib, "quartas", "2027-08-13", x1!, "PAL3", [0, 1]),
        cupGame(s.seasonId, lib, "quartas", "2027-08-20", "PAL3", x1!, [1, 0]),
        cupGame(s.seasonId, lib, "quartas", "2027-08-15", x2!, x3!, [0, 0]),
        cupGame(s.seasonId, lib, "quartas", "2027-08-22", x3!, x2!, null),
        cupGame(s.seasonId, lib, "semifinal", "2027-09-20", "PAL3", x3!, null),
      ]);
      // terminou o jogo de 20/08 com o PAL3 classificado: nada
      await close(s.seasonId, at("2027-08-21T12:00:00Z"));
      expect(await eventsOf(s.seasonId)).toEqual([]);
      // terminou o último jogo de volta da fase, em 22/08
      await t.db
        .update(matches)
        .set({ status: "finished", homeGoals: 1, awayGoals: 0, finishedAt: at("2027-08-22T23:30:00-03:00") })
        .where(eq(matches.id, lastLeg!.id));
      await close(s.seasonId, at("2027-08-22T23:33:00-03:00"));
      expect(await eventsOf(s.seasonId)).toEqual([
        expect.objectContaining({
          clubId: club("PAL3"),
          kind: "cup_phase",
          competition: "libertadores",
          round: null,
          phase: "quartas",
          perShare: 375,
          status: "pending",
          closedAt: at("2027-08-22T23:30:00-03:00"),
        }),
      ]);
    });

    it("div 16: final empatada com o VAS3 campeão nos pênaltis deixa R$ 8,00 de título aguardando", async () => {
      const s = await newSeason();
      await insertMatches([
        cupGame(s.seasonId, "copa-do-brasil", "final", "2027-12-19", "VAS3", "COR3", [1, 1], { advancedClubId: club("VAS3") }),
      ]);
      await close(s.seasonId, at("2027-12-20T12:00:00Z"));
      expect(await eventsOf(s.seasonId)).toEqual([
        expect.objectContaining({
          clubId: club("VAS3"),
          kind: "cup_title",
          competition: "copa-do-brasil",
          phase: "final",
          perShare: 800,
          status: "pending",
          closedAt: at("2027-12-19T23:30:00-03:00"),
        }),
      ]);
    });

    it("div 27: clube fora da lista que vence uma fase da Copa do Brasil não gera pagamento", async () => {
      const s = await newSeason();
      const [x1, x2] = outsiders;
      await insertMatches([
        cupGame(s.seasonId, "copa-do-brasil", "quartas", "2027-06-01", "RBB3", x1!, [1, 0]),
        cupGame(s.seasonId, "copa-do-brasil", "semifinal", "2027-08-01", "RBB3", x2!, [0, 0]),
        game(s.seasonId, 5, "RBB3", "FLA3", [3, 0], at("2027-05-09T16:00:00-03:00")),
      ]);
      await close(s.seasonId, at("2027-08-05T12:00:00Z"));
      expect(await eventsOf(s.seasonId)).toEqual([]);
    });
  });

  /** Grava a classificação oficial (já conferida) direto na tabela, na ordem dada. */
  async function importTable(seasonId: number, competition: string, order: number[]) {
    await t.db.execute(sql`
      insert into futbolsa.standings (season_id, competition, club_id, position, points, confirmed_at, updated_at)
      select ${seasonId}, ${competition}, c.id, c.pos, 0, now(), now()
      from unnest(${sql.raw(`array[${order.join(",")}]::int[]`)}) with ordinality as c(id, pos)`);
  }

  describe("quem dispara a passada", () => {
    it("o MatchesChangedEvent dispara a passada da temporada do evento", async () => {
      const s = await newSeason();
      const rows = await insertMatches([game(s.seasonId, 5, "FLA3", "PAL3", [2, 0], at("2027-05-09T16:00:00-03:00"))]);
      clock.set(at("2027-05-09T21:00:00-03:00"));
      await app.get(MatchesEvents, { strict: false }).publish({
        seasonId: s.seasonId,
        competition: "brasileirao-a",
        matchIds: [rows[0]!.id],
        clubIds: [club("FLA3"), club("PAL3")],
        scoreChanged: true,
      });
      expect(await eventOf(s.seasonId, "FLA3")).toEqual([expect.objectContaining({ status: "pending", perShare: 30, round: 5 })]);
    });

    it("a classificação importada e a corrigida disparam a passada", async () => {
      const s = await newSeason(); // a mais nova: é a temporada atual
      await insertMatches([game(s.seasonId, 38, "BOT3", "CEA3", [1, 0], at("2027-12-05T16:00:00-03:00"))]);
      clock.set(at("2027-12-06T12:00:00Z"));
      const standingsService = app.get(StandingsService, { strict: false });
      // a fonte traz a tabela na ordem do seed: FLA3 em 1º, FLU3 em 2º
      await standingsService.importStandings(
        s.seasonId,
        "brasileirao-a",
        CLUBS.map((c, i) => ({ clubName: c.name, position: i + 1, points: 80 - i })),
      );
      expect(await eventOf(s.seasonId, "FLA3", "pending")).toContainEqual(expect.objectContaining({ kind: "placement", perShare: 500 }));

      // o admin corrige: FLU3 em 1º, FLA3 em 2º
      const admin = await createUser(t.db);
      const order = ["FLU3", "FLA3", ...CLUBS.map((c) => c.id).slice(2)].map(club);
      clock.set(at("2027-12-06T13:00:00Z"));
      await standingsService.correct(admin, "brasileirao-a", { order, reason: "punição do tribunal" });
      const fla = (await eventOf(s.seasonId, "FLA3")).filter((e) => e.kind === "placement");
      expect(fla.map((e) => [e.version, e.status, e.perShare])).toEqual([
        [1, "superseded", 500],
        [2, "pending", 450],
      ]);
      const flu = (await eventOf(s.seasonId, "FLU3", "pending")).filter((e) => e.kind === "placement");
      expect(flu).toEqual([expect.objectContaining({ version: 2, perShare: 500 })]);
    });
  });

  it("só os eventos de clubes listados, e nenhum com status fora de pending nesta passada", async () => {
    const s = await newSeason();
    await insertMatches(round10(s.seasonId));
    await close(s.seasonId, after(ROUND10_CLOSE, 3));
    const ids = (await eventsOf(s.seasonId)).map((e) => e.clubId);
    expect(ids).not.toContain(club("JUV3"));
    expect(ids).not.toContain(club("RBB3"));
    expect(await t.db.select().from(payoutEvents).where(and(eq(payoutEvents.seasonId, s.seasonId), ne(payoutEvents.status, "pending")))).toEqual([]);
  });
});
