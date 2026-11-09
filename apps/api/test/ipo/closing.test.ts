import "reflect-metadata";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seasonViewSchema } from "@futbolsa/contracts";
import { ipoDates } from "@futbolsa/engine";
import { FixedClock } from "../../src/infra/clock/index.js";
import { adminLog, ipoBids, seasonClubs, seasons } from "../../src/infra/db/schema/index.js";
import { IpoClosingService } from "../../src/modules/ipo/index.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { expectAdminOnly } from "../support/admin-routes.js";
import { createTestApp } from "../support/app.js";
import { bearer, TOKEN_T0, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { openWallets, seedSeason } from "../support/fixtures.js";
import { assertLedgerConsistent } from "../support/invariants.js";

const MINUTE = 60_000;
/** Primeiro jogo em 2027-04-11 às 16h de Brasília: ofertas de 2027-03-28 a 2027-04-04 às 16h, negociação em 2027-04-05 às 10h. */
const FIRST_KICKOFF = new Date("2027-04-11T19:00:00Z");
const DATES = ipoDates(FIRST_KICKOFF.getTime());
const CLOSES_AT = new Date(DATES.closesAt);
/** Um instante com as ofertas abertas (o dos tokens padrão dos testes). */
const DURING = TOKEN_T0;
/** O adiamento do critério 28: 2027-04-06 às 16h de Brasília. */
const POSTPONED = "2027-04-06T19:00:00.000Z";

describe("fechar e adiar o IPO", () => {
  const database = useTestDatabase(10);
  const clock = new FixedClock(DURING);
  let app: NestFastifyApplication;
  let closing: IpoClosingService;
  let admin: TestAccount;
  let seasonId: number;

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    closing = app.get(IpoClosingService);
    admin = await createAccount(database.db, { role: "admin", nickname: "chefe_fecha" });
    let clubIds: Map<string, number>;
    ({ seasonId, clubIds } = await seedSeason(database.db, 2027));
    await database.db.insert(seasonClubs).values({ seasonId, clubId: clubIds.get("FLA3")!, division: "A", bandCenter: 5055, bandFloor: 3033, bandCeiling: 7077 });
  });
  afterAll(() => app?.close());
  beforeEach(async () => {
    clock.set(DURING);
    // O estado que a abertura (A2) deixa: ofertas abertas com as datas do primeiro jogo.
    await database.db
      .update(seasons)
      .set({
        status: "ipo_open",
        offerSize: 3000,
        firstKickoff: FIRST_KICKOFF,
        ipoOpensAt: new Date(DATES.opensAt),
        ipoClosesAt: CLOSES_AT,
        tradingOpensAt: new Date(DATES.tradingOpensAt),
      })
      .where(eq(seasons.id, seasonId));
  });

  const seasonRow = async () => (await database.db.select().from(seasons).where(eq(seasons.id, seasonId)))[0]!;
  const patch = async (payload: object) =>
    app.inject({ method: "PATCH", url: `/admin/seasons/${seasonId}`, headers: bearer(await admin.tokenWith({ at: clock.now() })), payload });
  const postponeLogs = () =>
    database.db
      .select()
      .from(adminLog)
      .where(and(eq(adminLog.action, "season.ipo.postpone"), eq(adminLog.targetId, String(seasonId))))
      .orderBy(asc(adminLog.id));

  /** Um jogador com carteira de R$ 100.000,00 e um jeito de mandar a oferta no FLA3 com o relógio de agora. */
  async function player() {
    const account = await createAccount(database.db);
    const [walletId] = await openWallets(database.db, seasonId, [{ type: "user", userId: account.id }]);
    const bid = async (quantity: number) =>
      app.inject({
        method: "PUT",
        url: "/ipo/bids/FLA3",
        headers: bearer(await account.tokenWith({ at: clock.now() })),
        payload: { quantity, maxPrice: 4000, expect: quantity === 100 ? "new" : "existing" },
      });
    return { account, walletId: walletId!, bid };
  }

  /** As datas da temporada como estavam antes: nada mudou. */
  async function expectDatesUnchanged() {
    const season = await seasonRow();
    expect(season.ipoOpensAt).toEqual(new Date(DATES.opensAt));
    expect(season.ipoClosesAt).toEqual(CLOSES_AT);
    expect(season.tradingOpensAt).toEqual(new Date(DATES.tradingOpensAt));
    expect(season.firstKickoff).toEqual(FIRST_KICKOFF);
    expect(season.offerSize).toBe(3000);
  }

  it("ipo 14: às 15h59 de 2027-04-04 a tarefa não fecha; às 16h a temporada passa para ipo_closed e a oferta é recusada", async () => {
    const { walletId, bid } = await player();
    expect((await bid(100)).statusCode).toBe(200);

    expect(await closing.closeIfDue(new Date(CLOSES_AT.getTime() - MINUTE))).toEqual({ status: "idle" });
    expect((await seasonRow()).status).toBe("ipo_open");

    expect(await closing.closeIfDue(CLOSES_AT)).toEqual({ status: "closed", seasonId, closedAt: CLOSES_AT });
    expect((await seasonRow()).status).toBe("ipo_closed");

    clock.set(new Date(CLOSES_AT.getTime() + MINUTE));
    const late = await bid(200);
    expect(late.statusCode).toBe(409);
    expect(late.json().code).toBe("ipo_closed");
    const [row] = await database.db.select().from(ipoBids).where(eq(ipoBids.walletId, walletId));
    expect(row).toMatchObject({ quantity: 100, status: "active" });
  });

  it("repetível: duas passadas depois do horário fecham uma vez; antes da abertura e depois do fechamento não faz nada", async () => {
    const after = new Date(CLOSES_AT.getTime() + 5 * MINUTE);
    expect((await closing.closeIfDue(after)).status).toBe("closed");
    expect(await closing.closeIfDue(after)).toEqual({ status: "idle" });
    expect((await seasonRow()).status).toBe("ipo_closed");

    await database.db.update(seasons).set({ status: "preparing" }).where(eq(seasons.id, seasonId));
    expect(await closing.closeIfDue(after)).toEqual({ status: "idle" });
    expect((await seasonRow()).status).toBe("preparing");
  });

  it("ipo 27: o primeiro jogo adiado para 2027-04-18 com o IPO aberto é recusado e as datas não mudam (fecha em 2027-04-04, negocia em 2027-04-05)", async () => {
    const res = await patch({ firstKickoff: "2027-04-18T19:00:00Z" });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("ipo_opened");
    await expectDatesUnchanged();
    expect(new Date(DATES.tradingOpensAt).toISOString()).toBe("2027-04-05T13:00:00.000Z");
    expect((await closing.closeIfDue(CLOSES_AT)).status).toBe("closed");
  });

  it("ipo 28 e admin 20: adiar para 2027-04-06 às 16h aceita ofertas até lá e a negociação vai para 2027-04-07 às 10h; o registro tem o antes e o depois", async () => {
    const { bid } = await player();
    const res = await patch({ ipoClosesAt: POSTPONED, reason: "rodada da Libertadores no fim de semana" });
    expect(res.statusCode).toBe(200);
    expect(seasonViewSchema.parse(res.json())).toMatchObject({
      status: "ipo_open",
      ipoOpensAt: new Date(DATES.opensAt).toISOString(),
      ipoClosesAt: POSTPONED,
      tradingOpensAt: "2027-04-07T13:00:00.000Z",
      firstKickoff: FIRST_KICKOFF.toISOString(),
    });

    const logs = await postponeLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      actorId: admin.id,
      targetType: "season",
      targetId: String(seasonId),
      before: { ipoClosesAt: "2027-04-04T19:00:00.000Z", tradingOpensAt: "2027-04-05T13:00:00.000Z" },
      after: { ipoClosesAt: POSTPONED, tradingOpensAt: "2027-04-07T13:00:00.000Z" },
      reason: "rodada da Libertadores no fim de semana",
    });

    // O fechamento antigo passou: a tarefa não fecha e as ofertas continuam.
    expect(await closing.closeIfDue(CLOSES_AT)).toEqual({ status: "idle" });
    clock.set(new Date("2027-04-05T12:00:00Z"));
    expect((await bid(100)).statusCode).toBe(200);
    clock.set(new Date(Date.parse(POSTPONED) - MINUTE));
    expect((await bid(150)).statusCode).toBe(200);
    expect(await closing.closeIfDue(clock.now())).toEqual({ status: "idle" });

    // No horário novo, fecha.
    clock.set(new Date(POSTPONED));
    expect((await bid(200)).json().code).toBe("ipo_closed");
    expect(await closing.closeIfDue(clock.now())).toEqual({ status: "closed", seasonId, closedAt: new Date(POSTPONED) });
  });

  it("adiar sem motivo também passa (motivo aceito, não exigido)", async () => {
    const res = await patch({ ipoClosesAt: POSTPONED });
    expect(res.statusCode).toBe(200);
    const [log] = (await postponeLogs()).slice(-1);
    expect(log!.reason).toBeNull();
  });

  it("ipo 28 e admin 20: antecipar para 2027-04-02 → ipo_close_earlier, nada muda e nada vai para o registro", async () => {
    const before = (await postponeLogs()).length;
    const res = await patch({ ipoClosesAt: "2027-04-02T19:00:00Z" });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("ipo_close_earlier");
    await expectDatesUnchanged();
    expect(await postponeLogs()).toHaveLength(before);
  });

  it("adiar depois do fechamento → ipo_closed: com a temporada em ipo_closed e com o horário passado e a tarefa ainda sem rodar", async () => {
    const before = (await postponeLogs()).length;
    // Horário de fechamento passado, temporada ainda em ipo_open (a tarefa não rodou).
    clock.set(CLOSES_AT);
    const late = await patch({ ipoClosesAt: POSTPONED });
    expect(late.statusCode).toBe(409);
    expect(late.json().code).toBe("ipo_closed");
    await expectDatesUnchanged();

    // Já fechada pela tarefa.
    clock.set(DURING);
    await database.db.update(seasons).set({ status: "ipo_closed" }).where(eq(seasons.id, seasonId));
    const closed = await patch({ ipoClosesAt: POSTPONED });
    expect(closed.statusCode).toBe(409);
    expect(closed.json().code).toBe("ipo_closed");
    await expectDatesUnchanged();
    expect(await postponeLogs()).toHaveLength(before);
  });

  it("com a temporada em preparing, o ipoClosesAt é recusado com ipo_not_open (e a oferta junto dele não muda)", async () => {
    await database.db.update(seasons).set({ status: "preparing" }).where(eq(seasons.id, seasonId));
    for (const payload of [{ ipoClosesAt: POSTPONED }, { ipoClosesAt: POSTPONED, offerSize: 5000 }]) {
      const res = await patch(payload);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("ipo_not_open");
      await expectDatesUnchanged();
    }
  });

  it("tudo ou nada: com o IPO aberto, oferta ou primeiro jogo junto do ipoClosesAt → ipo_opened e nem o fechamento muda", async () => {
    const before = (await postponeLogs()).length;
    for (const payload of [
      { ipoClosesAt: POSTPONED, offerSize: 4000 },
      { ipoClosesAt: POSTPONED, firstKickoff: "2027-04-18T19:00:00Z" },
      { ipoClosesAt: POSTPONED, offerSize: 4000, firstKickoff: "2027-04-18T19:00:00Z" },
    ]) {
      const res = await patch(payload);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("ipo_opened");
      await expectDatesUnchanged();
    }
    expect(await postponeLogs()).toHaveLength(before);
  });

  it("temporada que não existe volta 404", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/admin/seasons/999999",
      headers: bearer(await admin.tokenWith({ at: clock.now() })),
      payload: { ipoClosesAt: POSTPONED },
    });
    expect(res.statusCode).toBe(404);
  });

  it("admin 20 e 31: só o admin adia o fechamento", async () => {
    await expectAdminOnly(app, database.db, { method: "PATCH", url: `/admin/seasons/${seasonId}`, payload: { ipoClosesAt: POSTPONED } }, { okStatus: 200 });
  });

  it("invariantes: carteiras iguais à soma do extrato", async () => {
    await assertLedgerConsistent(database.db, seasonId);
  });
});
