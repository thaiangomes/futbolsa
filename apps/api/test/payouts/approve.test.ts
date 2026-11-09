import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { approvePayoutsResponseSchema } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { type Database, lockWallets, type Tx, withTransaction } from "../../src/infra/db/index.js";
import {
  adminLog,
  bots,
  payoutCredits,
  payoutEvents,
  payoutHoldings,
  seasons,
  standings,
  walletEntries,
  wallets,
} from "../../src/infra/db/schema/index.js";
import { ApproveService } from "../../src/modules/admin/payouts/approve.service.js";
import { holdingsAt, writeHoldings } from "../../src/modules/admin/payouts/holdings.js";
import { type PayoutsChange, RankingsPort } from "../../src/modules/admin/payouts/ports.js";
import { SettleCreditsService, SETTLE_BATCH } from "../../src/modules/admin/payouts/settle-credits.js";
import { PortfolioLedger } from "../../src/modules/portfolio/index.js";
import type { Movement } from "../../src/modules/portfolio/ledger/index.js";
import { post } from "../../src/modules/portfolio/ledger/index.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { expectAdminOnly } from "../support/admin-routes.js";
import { createTestApp } from "../support/app.js";
import { bearer, TOKEN_T0, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { listClubs, openPlayerWallets, openWallets, seedSeason } from "../support/fixtures.js";
import { assertLedgerConsistent, assertSharesConserved } from "../support/invariants.js";

const TOTAL = 10_000;
const TICKERS = ["BOT3", "CAM3", "COR3", "FLA3", "PAL3", "SAO3"];
/** Preço de R$ 1,00 por ação nos negócios de teste. */
const PRICE = 100;
/** Um horário (UTC) do dia do fechamento da rodada. */
const H = (hour: number, minute = 0) => new Date(Date.UTC(2027, 5, 6, hour, minute));
const CLOSE = H(20);

/** Tabela onde o `RankingsPort` de teste grava pelo `tx` que recebe: some se a transação desfaz. */
const CALLS = sql.raw("public.test_port_calls");

/** O `RankingsPort` de teste: grava o aviso pelo `tx` e, no `wake()`, quantos avisos já se veem de fora. */
class RecordingRankings extends RankingsPort {
  readonly changes: PayoutsChange[] = [];
  readonly wakes: Array<{ recorded: number; visible: number }> = [];
  /** Falha depois de gravar o aviso, para a transação da aprovação desfazer. */
  failAfterRecord = false;
  db!: Database;

  async payoutsChanged(tx: Tx, change: PayoutsChange): Promise<void> {
    await tx.db.execute(
      sql`insert into ${CALLS} (port, season_id, payload) values ('rankings', ${change.seasonId}, ${JSON.stringify(change.closedAts.map((d) => d.toISOString()))}::jsonb)`,
    );
    if (this.failAfterRecord) throw new Error("falha de teste depois do aviso aos rankings");
    this.changes.push(change);
  }

  async wake(): Promise<void> {
    const { rows } = await this.db.execute(sql`select count(*)::int as n from ${CALLS} where port = 'rankings'`);
    this.wakes.push({ recorded: this.changes.length, visible: Number(rows[0]!.n) });
  }
}

/** O livro das carteiras de verdade, que pode falhar a partir do N-ésimo lançamento (a API que cai no meio). */
class FlakyLedger extends PortfolioLedger {
  failFrom: number | null = null;
  posts = 0;

  post(tx: Tx, movement: Movement) {
    this.posts++;
    if (this.failFrom !== null && this.posts >= this.failFrom) throw new Error("falha de teste no meio da liquidação");
    return super.post(tx, movement);
  }
}

describe("aprovação dos pagamentos (POST /admin/payouts/approve)", () => {
  const t = useTestDatabase(10);
  const clock = new FixedClock(H(22));
  const rankings = new RecordingRankings();
  const ledger = new FlakyLedger();
  let app: NestFastifyApplication;
  let approve: ApproveService;
  let settle: SettleCreditsService;
  let admin: TestAccount;
  let seasonId: number;
  let clubIds: Map<string, number>;
  let treasury: number;
  let round = 0;

  const club = (ticker: string) => clubIds.get(ticker)!;

  beforeAll(async () => {
    rankings.db = t.db;
    await t.db.execute(sql`create table ${CALLS} (id serial primary key, port text not null, season_id int, payload jsonb)`);
    app = await createTestApp({
      db: t.db,
      clock,
      override: (b) => withTestAuth(clock)(b).overrideProvider(RankingsPort).useValue(rankings).overrideProvider(PortfolioLedger).useValue(ledger),
    });
    approve = app.get(ApproveService, { strict: false });
    settle = app.get(SettleCreditsService, { strict: false });
    admin = await createAccount(t.db, { role: "admin" });
    ({ seasonId, clubIds } = await seedSeason(t.db));
    await listClubs(t.db, seasonId, clubIds, TICKERS, TOTAL);
    [treasury] = (await openWallets(t.db, seasonId, [{ type: "treasury" }])) as [number];
    // a emissão: todas as ações de cada clube começam na tesouraria
    await withTransaction(t.db, async (tx) => {
      await lockWallets(tx, [treasury]);
      for (const ticker of TICKERS) {
        await post(tx, { walletId: treasury, at: H(8), kind: "adjustment", clubId: club(ticker), sharesDelta: TOTAL, price: 4000, costBasis: "purchase", reason: "emissão" });
      }
    });
  });
  afterAll(async () => {
    await settle?.whenIdle();
    await app?.close();
  });
  beforeEach(async () => {
    clock.set(H(22));
    settle.batchSize = SETTLE_BATCH;
    ledger.failFrom = null;
    ledger.posts = 0;
    rankings.failAfterRecord = false;
    rankings.changes.length = 0;
    rankings.wakes.length = 0;
    await t.db.execute(sql`delete from ${CALLS}`);
  });

  /** Passa ações de uma carteira a outra no instante dado (pelo extrato, como um negócio). */
  async function trade(from: number, to: number, ticker: string, shares: number, when: Date) {
    await withTransaction(t.db, async (tx) => {
      await lockWallets(tx, [from, to]);
      await post(tx, { walletId: from, at: when, kind: "trade", clubId: club(ticker), sharesDelta: -shares, cashDelta: shares * PRICE, price: PRICE, costBasis: "sale" });
      await post(tx, { walletId: to, at: when, kind: "trade", clubId: club(ticker), sharesDelta: shares, cashDelta: -shares * PRICE, price: PRICE, costBasis: "purchase" });
    });
  }

  /**
   * Um evento `pending` gravado direto (a passada de fechamento já tem os testes dela), com a foto tirada pelo
   * `holdingsAt` no fechamento ou dada à mão. Cada um com uma chave própria.
   */
  async function newEvent(o: {
    ticker: string;
    perShare: number;
    kind?: "points" | "placement" | "promotion";
    status?: "pending" | "approved" | "superseded";
    photo?: Array<[walletId: number, shares: number]>;
    closedAt?: Date;
  }): Promise<number> {
    const kind = o.kind ?? "points";
    const competition = kind === "promotion" ? "brasileirao-b" : "brasileirao-a";
    const stage = kind === "points" ? String(++round) : "fim";
    const closedAt = o.closedAt ?? CLOSE;
    const [row] = await t.db
      .insert(payoutEvents)
      .values({
        seasonId,
        clubId: club(o.ticker),
        eventKey: `${kind}|${competition}|${stage}|${o.ticker}`,
        kind,
        reason: kind === "points" ? `3 pontos, rodada ${stage}` : kind === "placement" ? "1º lugar" : "acesso à Série A",
        competition,
        round: kind === "points" ? round : null,
        perShare: o.perShare,
        closedAt,
        status: o.status ?? "pending",
        createdAt: closedAt,
      })
      .returning({ id: payoutEvents.id });
    const id = row!.id;
    if (o.photo) {
      await t.db.insert(payoutHoldings).values(o.photo.map(([walletId, shares]) => ({ eventId: id, walletId, shares })));
    } else {
      await writeHoldings(t.db, id, await holdingsAt(t.db, seasonId, club(o.ticker), closedAt));
    }
    return id;
  }

  const eventRow = async (id: number) => (await t.db.select().from(payoutEvents).where(eq(payoutEvents.id, id)))[0]!;
  const creditsOf = (id: number) => t.db.select().from(payoutCredits).where(eq(payoutCredits.eventId, id)).orderBy(asc(payoutCredits.walletId));
  const cashOf = async (walletId: number) => (await t.db.select({ cash: wallets.cash }).from(wallets).where(eq(wallets.id, walletId)))[0]!.cash;
  const dividendEntries = (id: number) =>
    t.db
      .select()
      .from(walletEntries)
      .where(and(eq(walletEntries.kind, "dividend"), eq(walletEntries.refType, "payout_event"), eq(walletEntries.refId, String(id))))
      .orderBy(asc(walletEntries.walletId));
  const approveOne = async (id: number) => (await approve.approve(admin.id, { eventIds: [id] })).results[0]!.outcome;
  /** Aprova e espera a liquidação acabar. */
  const approveAndSettle = async (id: number) => {
    const outcome = await approveOne(id);
    await settle.settleEvent(id);
    return outcome;
  };

  /** As chamadas às rotas usam o relógio no horário do token de teste. */
  const route = async (payload: unknown) => {
    clock.set(new Date(TOKEN_T0.getTime() + 60_000));
    const res = await app.inject({ method: "POST", url: "/admin/payouts/approve", payload: payload as object, headers: bearer(admin.token) });
    clock.set(H(22));
    return res;
  };

  it("admin 3: Ana recebe R$ 300,00 e Bruno nada pelas 500 que comprou depois", async () => {
    const [ana, bruno] = (await openPlayerWallets(t.db, seasonId, 2)) as [number, number];
    await trade(treasury, ana, "FLA3", 1_000, H(18));
    // a rodada fecha às 20h; Ana vende 500 a Bruno às 21h
    await trade(ana, bruno, "FLA3", 500, H(21));
    const id = await newEvent({ ticker: "FLA3", perShare: 30 });
    const [anaCash, brunoCash] = [await cashOf(ana), await cashOf(bruno)];

    // o admin aprova R$ 0,30 por ação às 22h
    expect(await approveAndSettle(id)).toBe("approved");

    const event = await eventRow(id);
    expect(event).toMatchObject({ status: "approved", approvedBy: admin.id, approvedAt: H(22) });
    expect(await cashOf(ana)).toBe(anaCash + 30_000);
    expect(await cashOf(bruno)).toBe(brunoCash);
    expect((await creditsOf(id)).map((c) => [c.walletId, c.amount])).toEqual([[ana, 30_000]]);
    const [entry] = await dividendEntries(id);
    expect(entry).toMatchObject({ walletId: ana, kind: "dividend", clubId: club("FLA3"), cashDelta: 30_000, sharesDelta: 0, reason: event.reason, at: H(22) });
    expect((await creditsOf(id))[0]!.entryId).toBe(entry!.id);
  });

  it("admin 4: Ana recebe pelas 400 presas na venda", async () => {
    const [ana] = (await openPlayerWallets(t.db, seasonId, 1)) as [number];
    await trade(treasury, ana, "CAM3", 1_000, H(18));
    // ordem de venda de 400 aberta às 19h, ainda aberta no fechamento e na aprovação
    await withTransaction(t.db, async (tx) => {
      await lockWallets(tx, [ana]);
      await post(tx, { walletId: ana, at: H(19), kind: "order_reserve", clubId: club("CAM3"), reservedSharesDelta: 400, openOrdersDelta: 1 });
    });
    const id = await newEvent({ ticker: "CAM3", perShare: 30 });
    const before = await cashOf(ana);
    expect(await approveAndSettle(id)).toBe("approved");
    expect(await cashOf(ana)).toBe(before + 30_000);
    expect((await creditsOf(id)).map((c) => [c.walletId, c.amount])).toEqual([[ana, 30_000]]);
  });

  it("aprovar duas vezes não paga duas vezes: a segunda diz 'já aprovado'", async () => {
    const [ana] = (await openPlayerWallets(t.db, seasonId, 1)) as [number];
    const id = await newEvent({ ticker: "PAL3", perShare: 20, photo: [[ana, 500]] });
    const before = await cashOf(ana);
    expect(await approveAndSettle(id)).toBe("approved");
    const approvedAt = (await eventRow(id)).approvedAt;
    clock.set(H(23));
    expect(await approveAndSettle(id)).toBe("already_approved");
    expect(await cashOf(ana)).toBe(before + 10_000);
    expect(await creditsOf(id)).toHaveLength(1);
    expect(await dividendEntries(id)).toHaveLength(1);
    // a segunda não muda o autor nem o horário, nem grava outro registro
    expect((await eventRow(id)).approvedAt).toEqual(approvedAt);
    expect(await t.db.select().from(adminLog).where(and(eq(adminLog.action, "payout.approve"), eq(adminLog.targetId, String(id))))).toHaveLength(1);
  });

  it("aprovar evento substituído dá event_superseded (409 na rota para um evento só) e não paga", async () => {
    const [ana] = (await openPlayerWallets(t.db, seasonId, 1)) as [number];
    const id = await newEvent({ ticker: "PAL3", perShare: 20, status: "superseded", photo: [[ana, 500]] });
    expect(await approveOne(id)).toBe("event_superseded");
    const res = await route({ eventIds: [id] });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("event_superseded");
    await settle.whenIdle();
    expect((await eventRow(id)).status).toBe("superseded");
    expect(await creditsOf(id)).toHaveLength(0);
  });

  it("evento inexistente: 404 na rota para um evento só; na lista, o resultado de cada um", async () => {
    const res = await route({ eventIds: [999_999] });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("not_found");
    const list = await route({ eventIds: [999_999, 999_998] });
    expect(list.statusCode).toBe(200);
    expect(approvePayoutsResponseSchema.parse(list.json()).results).toEqual([
      { eventId: 999_999, outcome: "not_found" },
      { eventId: 999_998, outcome: "not_found" },
    ]);
    expect((await route({ eventIds: [] })).statusCode).toBe(400);
    expect((await route({ all: false })).statusCode).toBe(400);
    await settle.whenIdle();
  });

  it("colocação e acesso com a classificação não conferida dão standings_not_confirmed (409 para um só; resultado no lote); conferida, aprova", async () => {
    const [ana] = (await openPlayerWallets(t.db, seasonId, 1)) as [number];
    const placement = await newEvent({ ticker: "SAO3", perShare: 500, kind: "placement", photo: [[ana, 100]] });
    const promotion = await newEvent({ ticker: "COR3", perShare: 200, kind: "promotion", photo: [[ana, 100]] });
    const points = await newEvent({ ticker: "COR3", perShare: 10, photo: [[ana, 100]] });

    const single = await route({ eventIds: [placement] });
    expect(single.statusCode).toBe(409);
    expect(single.json().code).toBe("standings_not_confirmed");

    // a tabela importada mas com uma linha sem conferência ainda não vale
    await t.db.insert(standings).values([
      { seasonId, competition: "brasileirao-a", clubId: club("SAO3"), position: 1, points: 80, confirmedAt: H(9), confirmedBy: admin.id },
      { seasonId, competition: "brasileirao-a", clubId: club("FLA3"), position: 2, points: 70 },
      { seasonId, competition: "brasileirao-b", clubId: club("COR3"), position: 1, points: 75 },
    ]);
    const batch = await route({ eventIds: [placement, promotion, points] });
    expect(batch.statusCode).toBe(200);
    expect(approvePayoutsResponseSchema.parse(batch.json()).results).toEqual([
      { eventId: placement, outcome: "standings_not_confirmed" },
      { eventId: promotion, outcome: "standings_not_confirmed" },
      { eventId: points, outcome: "approved" },
    ]);
    await settle.whenIdle();
    expect((await eventRow(placement)).status).toBe("pending");
    expect((await eventRow(promotion)).status).toBe("pending");
    expect(await creditsOf(placement)).toHaveLength(0);

    await t.db.update(standings).set({ confirmedAt: H(9), confirmedBy: admin.id }).where(eq(standings.seasonId, seasonId));
    expect(await approveAndSettle(placement)).toBe("approved");
    expect(await approveAndSettle(promotion)).toBe("approved");
    expect((await creditsOf(placement)).map((c) => c.amount)).toEqual([50_000]);
    expect((await creditsOf(promotion)).map((c) => c.amount)).toEqual([20_000]);
  });

  it("jogador bloqueado e bot recebem; conta excluída e tesouraria não; evento de R$ 0,00 não gera crédito", async () => {
    const blocked = await createAccount(t.db, { status: "blocked" });
    const gone = await createAccount(t.db, { status: "deleted" });
    const [botRow] = await t.db.insert(bots).values({ profile: "dividendos", active: true }).returning({ id: bots.id });
    const [blockedW, botW, goneW] = (await openWallets(t.db, seasonId, [
      { type: "user", userId: blocked.id },
      { type: "bot", botId: botRow!.id },
      { type: "user", userId: gone.id },
    ])) as [number, number, number];
    // a tesouraria nunca entra na foto; aqui ela entra à mão, para conferir que mesmo assim não recebe
    const photo: Array<[number, number]> = [[blockedW, 300], [botW, 200], [goneW, 100], [treasury, 1_000]];
    const id = await newEvent({ ticker: "BOT3", perShare: 40, photo });
    const zero = await newEvent({ ticker: "BOT3", perShare: 0, photo });
    const cash = async () => Promise.all([blockedW, botW, goneW, treasury].map(cashOf));
    const before = await cash();

    expect(await approveAndSettle(id)).toBe("approved");
    expect(await approveAndSettle(zero)).toBe("approved");

    expect((await creditsOf(id)).map((c) => [c.walletId, c.amount])).toEqual([
      [blockedW, 12_000],
      [botW, 8_000],
    ]);
    expect(await creditsOf(zero)).toHaveLength(0);
    expect(await cash()).toEqual([before[0]! + 12_000, before[1]! + 8_000, before[2], before[3]]);
    // a tarefa não acha nada faltando nestes dois: a conta excluída e a tesouraria não contam como pendentes
    const summary = await settle.settlePending();
    expect(summary.credited).toBe(0);
  });

  it("dividendo abate o caixa negativo", async () => {
    const [ana] = (await openPlayerWallets(t.db, seasonId, 1, 0)) as [number];
    // um estorno anterior deixou a carteira com −R$ 50,00
    await withTransaction(t.db, async (tx) => {
      await lockWallets(tx, [ana]);
      await post(tx, { walletId: ana, at: H(10), kind: "reversal", clubId: club("FLA3"), cashDelta: -5_000, reason: "correção do placar" });
    });
    expect(await cashOf(ana)).toBe(-5_000);
    const id = await newEvent({ ticker: "FLA3", perShare: 30, photo: [[ana, 1_000]] });
    expect(await approveAndSettle(id)).toBe("approved");
    expect(await cashOf(ana)).toBe(25_000);
    const [entry] = await dividendEntries(id);
    expect(entry).toMatchObject({ cashDelta: 30_000, cashAfter: 25_000 });
  });

  it("a liquidação interrompida depois de 2 lotes termina pela tarefa sem crédito repetido", async () => {
    const holders = await openPlayerWallets(t.db, seasonId, 7);
    const id = await newEvent({ ticker: "PAL3", perShare: 10, photo: holders.map((w, i) => [w, 100 + i] as [number, number]) });
    const before = await Promise.all(holders.map(cashOf));
    expect(await approveOne(id)).toBe("approved");

    // lotes de 2 carteiras; a API "cai" no primeiro lançamento do 3º lote, que desfaz inteiro
    settle.batchSize = 2;
    ledger.posts = 0;
    ledger.failFrom = 5;
    await expect(settle.settleEvent(id)).rejects.toThrow(/falha de teste/);
    expect(await creditsOf(id)).toHaveLength(4);
    expect(await dividendEntries(id)).toHaveLength(4);

    // a tarefa de liquidação continua de onde parou
    ledger.failFrom = null;
    const summary = await settle.settlePending();
    expect(summary.errors).toEqual([]);
    expect(await creditsOf(id)).toHaveLength(7);
    expect((await dividendEntries(id)).map((e) => e.walletId)).toEqual([...holders].sort((a, b) => a - b));
    const after = await Promise.all(holders.map(cashOf));
    expect(after).toEqual(before.map((c, i) => c + (100 + i) * 10));
    // rodar de novo não acha mais nada
    expect((await settle.settlePending()).credited).toBe(0);
    expect(await creditsOf(id)).toHaveLength(7);
  });

  it("admin 33: a aprovação vai para o registro (autor, antes e depois)", async () => {
    const [ana] = (await openPlayerWallets(t.db, seasonId, 1)) as [number];
    const id = await newEvent({ ticker: "SAO3", perShare: 30, photo: [[ana, 100]] });
    expect(await approveOne(id)).toBe("approved");
    const rows = await t.db.select().from(adminLog).where(and(eq(adminLog.action, "payout.approve"), eq(adminLog.targetId, String(id))));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: admin.id,
      at: H(22),
      targetType: "payout_event",
      before: { status: "pending", perShare: 30, key: `points|brasileirao-a|${round}|SAO3`, version: 1, closedAt: CLOSE.toISOString() },
      after: { status: "approved", perShare: 30, approvedAt: H(22).toISOString() },
      reason: null,
    });
    await settle.settleEvent(id);
  });

  it("o aviso ao RankingsPort entra na transação da aprovação e some se ela desfaz; os lotes não avisam; wake() só depois do COMMIT", async () => {
    const [ana] = (await openPlayerWallets(t.db, seasonId, 1)) as [number];
    const closedAt = H(19, 30);
    const id = await newEvent({ ticker: "SAO3", perShare: 30, photo: [[ana, 100]], closedAt });

    // a transação desfaz depois do aviso: nem o aviso, nem a aprovação, nem o registro ficam; nada de wake()
    rankings.failAfterRecord = true;
    await expect(approve.approve(admin.id, { eventIds: [id] })).rejects.toThrow(/falha de teste/);
    const visible = async () => Number((await t.db.execute(sql`select count(*)::int as n from ${CALLS} where port = 'rankings'`)).rows[0]!.n);
    expect(await visible()).toBe(0);
    expect(rankings.wakes).toEqual([]);
    expect((await eventRow(id)).status).toBe("pending");
    expect(await t.db.select().from(adminLog).where(eq(adminLog.targetId, String(id)))).toHaveLength(0);

    rankings.failAfterRecord = false;
    expect(await approveOne(id)).toBe("approved");
    expect(rankings.changes).toEqual([{ seasonId, closedAts: [closedAt] }]);
    // no wake() o aviso já está gravado e visível de fora: o COMMIT veio antes
    expect(rankings.wakes).toEqual([{ recorded: 1, visible: 1 }]);

    await settle.settleEvent(id);
    expect(await creditsOf(id)).toHaveLength(1);
    expect(rankings.changes).toHaveLength(1);
    expect(rankings.wakes).toHaveLength(1);
    expect(await visible()).toBe(1);
  });

  it("all: true aprova os pendentes em ordem de id e devolve o resultado de cada um; a liquidação segue em segundo plano", async () => {
    const [ana] = (await openPlayerWallets(t.db, seasonId, 1)) as [number];
    const ids = [
      await newEvent({ ticker: "FLA3", perShare: 10, photo: [[ana, 100]] }),
      await newEvent({ ticker: "CAM3", perShare: 20, photo: [[ana, 100]] }),
      await newEvent({ ticker: "PAL3", perShare: 30, photo: [[ana, 100]] }),
    ];
    const pendingBefore = (
      await t.db.select({ id: payoutEvents.id }).from(payoutEvents).where(and(eq(payoutEvents.seasonId, seasonId), eq(payoutEvents.status, "pending"))).orderBy(asc(payoutEvents.id))
    ).map((r) => r.id);
    expect(pendingBefore).toEqual(expect.arrayContaining(ids));
    const before = await cashOf(ana);

    const res = await route({ all: true });
    expect(res.statusCode).toBe(200);
    const { results } = approvePayoutsResponseSchema.parse(res.json());
    expect(results.map((r) => r.eventId)).toEqual(pendingBefore);
    for (const id of ids) expect(results.find((r) => r.eventId === id)!.outcome).toBe("approved");
    // a resposta sai depois da etapa 1: os eventos já estão aprovados
    for (const id of ids) expect((await eventRow(id)).status).toBe("approved");

    await settle.whenIdle();
    expect(await cashOf(ana)).toBe(before + 1_000 + 2_000 + 3_000);
    // o que sobrou pendente é só o que não pode ser aprovado
    const left = await t.db.select().from(payoutEvents).where(and(eq(payoutEvents.seasonId, seasonId), eq(payoutEvents.status, "pending")));
    for (const e of left) expect(results.find((r) => r.eventId === e.id)!.outcome).toBe("standings_not_confirmed");

    // sem pendentes: 200 com a lista vazia
    const again = await route({ all: true });
    expect(again.statusCode).toBe(200);
    expect(again.json().results.filter((r: { outcome: string }) => r.outcome === "approved")).toEqual([]);
    await settle.whenIdle();
  });

  it("admin 31: jogador comum não aprova pagamentos", async () => {
    clock.set(new Date(TOKEN_T0.getTime() + 60_000));
    await expectAdminOnly(app, t.db, { method: "POST", url: "/admin/payouts/approve", payload: { eventIds: [999_999] } }, { okStatus: 404 });
    await settle.whenIdle();
  });

  it("caixa e ações batem depois dos créditos", async () => {
    await settle.whenIdle();
    await assertLedgerConsistent(t.db, seasonId);
    await assertSharesConserved(t.db, seasonId);
    // cada crédito tem a linha do extrato com o mesmo valor, e o caixa total subiu exatamente o creditado
    const { rows } = await t.db.execute(sql`
      select count(*)::int as n from futbolsa.payout_credits c
      join futbolsa.wallet_entries e on e.id = c.entry_id
      where e.cash_delta <> c.amount or e.wallet_id <> c.wallet_id or e.kind <> 'dividend'`);
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it("temporada encerrada: 409 season_closed, na lista e no all", async () => {
    const [ana] = (await openPlayerWallets(t.db, seasonId, 1)) as [number];
    const id = await newEvent({ ticker: "FLA3", perShare: 10, photo: [[ana, 100]] });
    const [{ status }] = (await t.db.select({ status: seasons.status }).from(seasons).where(eq(seasons.id, seasonId))) as [{ status: string }];
    await t.db.update(seasons).set({ status: "closed", closedAt: H(21) }).where(eq(seasons.id, seasonId));
    try {
      for (const payload of [{ all: true }, { eventIds: [id] }, { eventIds: [id, 999_999] }]) {
        const res = await route(payload);
        expect(res.statusCode).toBe(409);
        expect(res.json().code).toBe("season_closed");
      }
      await expect(approve.approve(admin.id, { eventIds: [id] })).rejects.toMatchObject({ code: "season_closed", status: 409 });
      expect((await eventRow(id)).status).toBe("pending");
    } finally {
      await t.db.update(seasons).set({ status, closedAt: null }).where(eq(seasons.id, seasonId));
      await settle.whenIdle();
    }
  });
});
