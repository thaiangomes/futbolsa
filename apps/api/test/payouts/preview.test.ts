import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { payoutHoldersResponseSchema, payoutListResponseSchema, type PayoutEventView } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { lockWallets, withTransaction } from "../../src/infra/db/index.js";
import { bots, payoutCredits, payoutEvents, payoutHoldings, seasons, standings } from "../../src/infra/db/schema/index.js";
import { post } from "../../src/modules/portfolio/ledger/index.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { expectAdminOnly } from "../support/admin-routes.js";
import { createTestApp } from "../support/app.js";
import { bearer, TOKEN_T0, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { listClubs, openWallets, seedSeason } from "../support/fixtures.js";

const CLOSED_AT = new Date("2027-06-06T20:00:00Z");

describe("prévia dos pagamentos (GET /admin/payouts)", () => {
  const database = useTestDatabase(10);
  const clock = new FixedClock(new Date(TOKEN_T0.getTime() + 60_000));
  let app: NestFastifyApplication;
  let admin: TestAccount;
  let seasonId: number;
  let clubIds: Map<string, number>;
  /** O evento do critério 2: FLA3, R$ 0,30 por ação, rodada 10. */
  let eventId: number;
  let ana: number;
  let bruno: number;
  let bot: number;
  let deleted: number;
  let treasury: number;

  const call = (url: string) => app.inject({ method: "GET", url, headers: bearer(admin.token) });
  const listAll = async (query = "") => payoutListResponseSchema.parse((await call(`/admin/payouts${query}`)).json());
  const list = async (query = "") => (await listAll(query)).events;

  const insertEvent = async (o: {
    ticker: string;
    key: string;
    kind: "points" | "placement" | "promotion" | "cup_phase";
    perShare: number;
    status?: "pending" | "approved" | "superseded";
    competition?: "brasileirao-a" | "brasileirao-b" | "copa-do-brasil";
    round?: number | null;
    phase?: string | null;
    reason?: string;
    closedAt?: Date;
  }) => {
    const [row] = await database.db
      .insert(payoutEvents)
      .values({
        seasonId,
        clubId: clubIds.get(o.ticker)!,
        eventKey: o.key,
        kind: o.kind,
        reason: o.reason ?? "3 pontos, rodada 10",
        competition: o.competition ?? "brasileirao-a",
        round: o.round === undefined ? 10 : o.round,
        phase: o.phase ?? null,
        perShare: o.perShare,
        closedAt: o.closedAt ?? CLOSED_AT,
        status: o.status ?? "pending",
        approvedAt: o.status === "approved" ? CLOSED_AT : null,
        createdAt: CLOSED_AT,
      })
      .returning({ id: payoutEvents.id });
    return row!.id;
  };
  const photo = (id: number, rows: Array<[number, number]>) =>
    database.db.insert(payoutHoldings).values(rows.map(([walletId, shares]) => ({ eventId: id, walletId, shares })));

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: (b) => withTestAuth(clock)(b) });
    admin = await createAccount(database.db, { role: "admin" });
    ({ seasonId, clubIds } = await seedSeason(database.db));
    await listClubs(database.db, seasonId, clubIds, ["FLA3", "CAM3", "PAL3"], 10_000);

    // jogadores (um bloqueado), um bot, uma conta excluída e a tesouraria
    const anaAccount = await createAccount(database.db, { nickname: "ana" });
    const brunoAccount = await createAccount(database.db, { nickname: "bruno", status: "blocked" });
    const gone = await createAccount(database.db, { status: "deleted" });
    const [botRow] = await database.db.insert(bots).values({ profile: "dividendos", active: true }).returning({ id: bots.id });
    [ana, bruno, bot, deleted, treasury] = (await openWallets(database.db, seasonId, [
      { type: "user", userId: anaAccount.id },
      { type: "user", userId: brunoAccount.id },
      { type: "bot", botId: botRow!.id },
      { type: "user", userId: gone.id },
      { type: "treasury" },
    ])) as [number, number, number, number, number];

    // critério 2: 3.000 ações com jogadores, 500 com bots e 1.000 na tesouraria (a foto não leva a tesouraria)
    eventId = await insertEvent({ ticker: "FLA3", key: "points|brasileirao-a|10|FLA3", kind: "points", perShare: 30 });
    await photo(eventId, [
      [ana, 2000],
      [bruno, 1000],
      [bot, 500],
      [deleted, 80],
    ]);
  });
  afterAll(() => app.close());

  it("admin 2: a prévia de R$ 0,30 com 3.000 ações de jogadores, 500 de bots e 1.000 na tesouraria mostra 3.500 ações e R$ 1.050,00", async () => {
    // as 1.000 ações da tesouraria existem no banco, mas nunca entram na foto nem na prévia
    await withTransaction(database.db, async (tx) => {
      await lockWallets(tx, [treasury]);
      await post(tx, { walletId: treasury, at: CLOSED_AT, kind: "adjustment", clubId: clubIds.get("FLA3")!, sharesDelta: 1000, price: 4000, costBasis: "purchase", reason: "emissão" });
    });
    const events = await list();
    const e = events.find((x) => x.id === eventId)!;
    expect(e).toMatchObject({
      key: "points|brasileirao-a|10|FLA3",
      kind: "points",
      club: { ticker: "FLA3" },
      competition: "brasileirao-a",
      round: 10,
      phase: null,
      reason: "3 pontos, rodada 10",
      perShare: 30,
      closedAt: CLOSED_AT.toISOString(),
      status: "pending",
      version: 1,
      approvedAt: null,
      standingsConfirmed: null,
    });
    // a conta excluída (80 ações) não conta: não recebe
    expect(e.shares).toEqual({ players: 3000, bots: 500, total: 3500 });
    expect(e.total).toBe(105_000);
    expect(e.settlement).toEqual({ state: "not_started", credited: 0, expected: 0 });
  });

  it("os filtros de situação, competição, rodada e fase; o padrão traz aguardando e aprovados, sem os substituídos", async () => {
    const approved = await insertEvent({ ticker: "CAM3", key: "points|brasileirao-a|9|CAM3", kind: "points", perShare: 10, status: "approved", round: 9, reason: "1 ponto, rodada 9" });
    const old = await insertEvent({ ticker: "PAL3", key: "points|brasileirao-a|9|PAL3", kind: "points", perShare: 10, status: "superseded", round: 9 });
    const cup = await insertEvent({
      ticker: "PAL3",
      key: "cup_phase|copa-do-brasil|oitavas|PAL3",
      kind: "cup_phase",
      perShare: 100,
      competition: "copa-do-brasil",
      round: null,
      phase: "oitavas",
      reason: "avançou da fase oitavas",
    });
    const ids = (events: PayoutEventView[]) => events.map((e) => e.id).sort((a, b) => a - b);

    expect(ids(await list())).toEqual([eventId, approved, cup].sort((a, b) => a - b));
    expect(ids(await list("?status=pending"))).toEqual([eventId, cup].sort((a, b) => a - b));
    expect(ids(await list("?status=approved"))).toEqual([approved]);
    expect(ids(await list("?status=superseded"))).toEqual([old]);
    expect(ids(await list("?competition=brasileirao-a&round=10"))).toEqual([eventId]);
    expect(ids(await list("?competition=copa-do-brasil&phase=oitavas"))).toEqual([cup]);
    expect((await call("/admin/payouts?status=pago")).statusCode).toBe(400);
  });

  it("admin 46: a lista vem do fechamento mais novo para o mais antigo, com filtros de clube, tipo e período e paginação feita na API", async () => {
    const dia = (n: number) => new Date(Date.UTC(2027, 5, n, 20));
    const antes = await listAll();
    const novo = await insertEvent({ ticker: "CAM3", key: "points|brasileirao-a|42|CAM3", kind: "points", perShare: 10, round: 42, closedAt: dia(20) });
    const meio = await insertEvent({ ticker: "PAL3", key: "points|brasileirao-a|41|PAL3", kind: "points", perShare: 10, round: 41, closedAt: dia(13) });
    const copa = await insertEvent({ ticker: "PAL3", key: "cup_phase|copa-do-brasil|semifinal|PAL3", kind: "cup_phase", perShare: 100, competition: "copa-do-brasil", round: null, phase: "semifinal", closedAt: dia(13) });
    const aprovado = await insertEvent({ ticker: "CAM3", key: "points|brasileirao-a|39|CAM3", kind: "points", perShare: 10, status: "approved", round: 39, closedAt: dia(1) });
    const meus = new Set([novo, meio, copa, aprovado]);
    const ids = (events: PayoutEventView[]) => events.map((e) => e.id);
    const meusDe = (events: PayoutEventView[]) => ids(events).filter((id) => meus.has(id));

    // o mais novo primeiro; no mesmo fechamento, pelo clube e, no mesmo clube, o evento mais novo
    const tudo = await listAll("?pageSize=100");
    expect(meusDe(tudo.events)).toEqual([novo, copa, meio, aprovado]);
    const datas = tudo.events.map((e) => Date.parse(e.closedAt));
    expect(datas).toEqual([...datas].sort((x, y) => y - x));
    expect(tudo.total).toBe(antes.total + 4);
    expect(tudo.pendingTotal).toBe(antes.pendingTotal + 3);
    expect([antes.page, antes.pageSize]).toEqual([1, 50]);

    // filtros
    const pal = await list("?club=PAL3&pageSize=100");
    expect(pal.every((e) => e.club.ticker === "PAL3")).toBe(true);
    expect(meusDe(pal)).toEqual([copa, meio]);
    expect(meusDe(await list("?club=pal3&pageSize=100"))).toEqual([copa, meio]);
    expect(ids(await list("?kind=cup_phase&club=PAL3&phase=semifinal"))).toEqual([copa]);
    expect(meusDe(await list("?kind=points&status=pending&pageSize=100"))).toEqual([novo, meio]);
    expect(ids(await list(`?closedFrom=${dia(13).toISOString()}&closedBefore=${dia(14).toISOString()}`))).toEqual([copa, meio]);
    expect(ids(await list(`?closedBefore=${dia(2).toISOString()}`))).toEqual([aprovado]);

    // paginação: as páginas seguem a mesma ordem da lista inteira, o total vale para todas e o "aprovar todos" não depende do filtro
    const pedaco = 3;
    const todas: number[] = [];
    for (let p = 1; p * pedaco - pedaco < tudo.total; p++) {
      const pagina = await listAll(`?pageSize=${pedaco}&page=${p}`);
      expect([pagina.page, pagina.pageSize, pagina.total, pagina.pendingTotal]).toEqual([p, pedaco, tudo.total, tudo.pendingTotal]);
      expect(pagina.events.length).toBeLessThanOrEqual(pedaco);
      todas.push(...ids(pagina.events));
    }
    expect(todas).toEqual(ids(tudo.events));
    expect((await listAll(`?pageSize=${pedaco}&page=${Math.ceil(tudo.total / pedaco) + 1}`)).events).toEqual([]);
    const filtrada = await listAll("?kind=cup_phase&club=PAL3&phase=semifinal&pageSize=1");
    expect([filtrada.total, filtrada.pendingTotal]).toEqual([1, tudo.pendingTotal]);
    for (const ruim of ["?page=0", "?pageSize=101", "?pageSize=0", "?kind=pago", "?closedFrom=ontem"]) expect((await call(`/admin/payouts${ruim}`)).statusCode, ruim).toBe(400);
  });

  it("colocação e acesso mostram se a classificação oficial já foi conferida; os outros tipos não", async () => {
    const placement = await insertEvent({
      ticker: "FLA3",
      key: "placement|brasileirao-a|fim|FLA3",
      kind: "placement",
      perShare: 500,
      round: null,
      reason: "1º lugar",
    });
    const promotion = await insertEvent({
      ticker: "CAM3",
      key: "promotion|brasileirao-b|fim|CAM3",
      kind: "promotion",
      perShare: 200,
      competition: "brasileirao-b",
      round: null,
      reason: "acesso à Série A: 2º na Série B",
    });
    const state = async () => {
      const events = await list();
      return { placement: events.find((e) => e.id === placement)!.standingsConfirmed, promotion: events.find((e) => e.id === promotion)!.standingsConfirmed };
    };
    // sem tabela importada: não conferida
    expect(await state()).toEqual({ placement: false, promotion: false });

    await database.db.insert(standings).values([
      { seasonId, competition: "brasileirao-a", clubId: clubIds.get("FLA3")!, position: 1, points: 80 },
      { seasonId, competition: "brasileirao-a", clubId: clubIds.get("CAM3")!, position: 2, points: 70 },
      { seasonId, competition: "brasileirao-b", clubId: clubIds.get("PAL3")!, position: 1, points: 80 },
    ]);
    expect(await state()).toEqual({ placement: false, promotion: false });

    // só a Série A conferida (todas as linhas)
    await database.db.update(standings).set({ confirmedAt: CLOSED_AT, confirmedBy: admin.id }).where(eq(standings.competition, "brasileirao-a"));
    expect(await state()).toEqual({ placement: true, promotion: false });
    // uma linha sem conferência derruba a tabela inteira
    await database.db
      .update(standings)
      .set({ confirmedAt: null, confirmedBy: null })
      .where(eq(standings.clubId, clubIds.get("CAM3")!));
    expect(await state()).toEqual({ placement: false, promotion: false });
  });

  it("a liquidação de um evento aprovado: faltando crédito é 'liquidando', com todos é 'liquidada'; a conta excluída não conta", async () => {
    const id = await insertEvent({ ticker: "FLA3", key: "points|brasileirao-a|11|FLA3", kind: "points", perShare: 20, status: "approved", round: 11, reason: "2 pontos, rodada 11" });
    await photo(id, [
      [ana, 1000],
      [bot, 500],
      [deleted, 50],
    ]);
    const settlement = async () => (await list()).find((e) => e.id === id)!.settlement;
    expect(await settlement()).toEqual({ state: "settling", credited: 0, expected: 2 });

    const credit = async (walletId: number, shares: number) =>
      withTransaction(database.db, async (tx) => {
        await lockWallets(tx, [walletId]);
        const { entry } = await post(tx, { walletId, at: CLOSED_AT, kind: "dividend", clubId: clubIds.get("FLA3")!, cashDelta: shares * 20, ref: { type: "payout_event", id }, reason: "2 pontos, rodada 11" });
        await tx.db.insert(payoutCredits).values({ eventId: id, walletId, amount: shares * 20, entryId: entry.id });
      });
    await credit(ana, 1000);
    expect(await settlement()).toEqual({ state: "settling", credited: 1, expected: 2 });
    await credit(bot, 500);
    expect(await settlement()).toEqual({ state: "settled", credited: 2, expected: 2 });
  });

  it("os donos de um evento vêm paginados, com o bot marcado e a conta excluída à parte", async () => {
    const res = await call(`/admin/payouts/${eventId}/holders`);
    expect(res.statusCode).toBe(200);
    const page = payoutHoldersResponseSchema.parse(res.json());
    expect(page).toMatchObject({ page: 1, pageSize: 50, total: 4 });
    // do maior para o menor número de ações
    expect(page.holders).toEqual([
      { walletId: ana, kind: "player", nickname: "ana", shares: 2000, amount: 60_000, credited: null },
      { walletId: bruno, kind: "player", nickname: "bruno", shares: 1000, amount: 30_000, credited: null },
      { walletId: bot, kind: "bot", nickname: "bot dividendos", shares: 500, amount: 15_000, credited: null },
      { walletId: deleted, kind: "deleted", nickname: null, shares: 80, amount: 0, credited: null },
    ]);

    const second = payoutHoldersResponseSchema.parse((await call(`/admin/payouts/${eventId}/holders?page=2&pageSize=3`)).json());
    expect(second).toMatchObject({ page: 2, pageSize: 3, total: 4 });
    expect(second.holders.map((h) => h.walletId)).toEqual([deleted]);
  });

  it("os donos mostram o que já foi creditado", async () => {
    const id = await insertEvent({ ticker: "CAM3", key: "points|brasileirao-a|12|CAM3", kind: "points", perShare: 10, status: "approved", round: 12 });
    await photo(id, [[ana, 100]]);
    await withTransaction(database.db, async (tx) => {
      await lockWallets(tx, [ana]);
      const { entry } = await post(tx, { walletId: ana, at: CLOSED_AT, kind: "dividend", clubId: clubIds.get("CAM3")!, cashDelta: 1000, reason: "x" });
      await tx.db.insert(payoutCredits).values({ eventId: id, walletId: ana, amount: 1000, entryId: entry.id });
    });
    const page = payoutHoldersResponseSchema.parse((await call(`/admin/payouts/${id}/holders`)).json());
    expect(page.holders).toEqual([{ walletId: ana, kind: "player", nickname: "ana", shares: 100, amount: 1000, credited: 1000 }]);
  });

  it("evento inexistente dá 404, e id inválido 400", async () => {
    expect((await call("/admin/payouts/999999/holders")).statusCode).toBe(404);
    expect((await call("/admin/payouts/abc/holders")).statusCode).toBe(400);
    expect((await call(`/admin/payouts/${eventId}/holders?pageSize=1000`)).statusCode).toBe(400);
  });

  it("sem temporada em andamento a lista vem vazia", async () => {
    await database.db.update(seasons).set({ status: "closed", closedAt: CLOSED_AT });
    expect(await list()).toEqual([]);
    await database.db.update(seasons).set({ status: "preparing", closedAt: null });
  });

  it("admin 31: jogador comum não acessa GET /admin/payouts nem os donos de um evento", async () => {
    await expectAdminOnly(app, database.db, { method: "GET", url: "/admin/payouts" }, { okStatus: 200 });
    await expectAdminOnly(app, database.db, { method: "GET", url: `/admin/payouts/${eventId}/holders` }, { okStatus: 200 });
  });

});
