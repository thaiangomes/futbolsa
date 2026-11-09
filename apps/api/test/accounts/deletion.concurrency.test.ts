import "reflect-metadata";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixedClock } from "../../src/infra/clock/index.js";
import { ipoBids, positions, seasonClubs, seasons, users, wallets } from "../../src/infra/db/schema/index.js";
import { AccountDeletionService } from "../../src/modules/accounts/index.js";
import { IpoBidsService, IpoClosingService, IpoSettlementService } from "../../src/modules/ipo/index.js";
import { createAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { INITIAL_CASH, openWallets, seedSeason, sleep } from "../support/fixtures.js";
import { assertLedgerConsistent, assertSharesConserved } from "../support/invariants.js";

/** 20 rodadas, como os testes das travas da F4: metade com o fechamento na frente, metade com a exclusão. */
const ROUNDS = 20;
const OPENS_AT = new Date("2027-03-28T19:00:00Z");
const CLOSES_AT = new Date("2027-04-04T19:00:00Z");
const DURING = new Date("2027-03-30T15:00:00Z");
const SETTLE_AT = new Date("2027-04-04T19:01:00Z");
const BAND = { bandCenter: 5055, bandFloor: 3033, bandCeiling: 7077 };
/** Cada jogador oferta 100 FLA3 até R$ 40: R$ 4.000,00 reservados. */
const QTY = 100;
const MAX_PRICE = 4000;

/**
 * Exclusão de conta no instante do fechamento do IPO. O `deleteAccount` (F5) lê o status da temporada
 * sem trava para decidir entre encerrar a carteira já ou depois da liquidação; o encerramento trava a
 * temporada e, se o fechamento passa na frente enquanto ele espera a trava, a temporada já está em
 * `ipo_closed` e o gancho do IPO (proposta 8) não cancela a oferta. A ordem das duas transações é forçada
 * pela própria fila da trava: uma transação de fora segura a linha da temporada, as duas chegam e ficam
 * esperando, na ordem da rodada, e só então a de fora termina.
 */
describe("exclusão de conta contra o fechamento do IPO, contra o Postgres", () => {
  const database = useTestDatabase(10);
  const clock = new FixedClock(DURING);
  let app: NestFastifyApplication;
  let seasonId: number;
  let fla: number;
  let treasury: number;

  /** Espera até `n` conexões deste banco estarem paradas numa trava. */
  async function waitForLockWaiters(n: number) {
    for (let i = 0; i < 200; i++) {
      const res = await database.conn.pool.query(
        "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
      );
      if (res.rows[0].n >= n) return;
      await sleep(10);
    }
    throw new Error(`as ${n} transações não chegaram à trava da temporada`);
  }

  /**
   * Roda `first` e `second` com a temporada presa por uma transação de fora, de modo que a primeira chegue
   * à trava antes da segunda; solta a temporada e devolve os dois resultados (ou o erro de cada um).
   */
  async function inLockOrder<A, B>(first: () => Promise<A>, second: () => Promise<B>) {
    const gate = await database.conn.pool.connect();
    try {
      await gate.query("begin");
      await gate.query("select id from futbolsa.seasons where id = $1 for update", [seasonId]);
      const settle = <T>(p: Promise<T>) => p.then((value) => ({ value }), (error: unknown) => ({ error }));
      const a = settle(first());
      await waitForLockWaiters(1);
      const b = settle(second());
      await waitForLockWaiters(2);
      await gate.query("commit");
      return [await a, await b] as const;
    } finally {
      gate.release();
    }
  }

  const reopen = () => database.db.update(seasons).set({ status: "ipo_open" }).where(eq(seasons.id, seasonId));

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    let clubIds: Map<string, number>;
    ({ seasonId, clubIds } = await seedSeason(database.db, 2027));
    fla = clubIds.get("FLA3")!;
    await database.db.insert(seasonClubs).values({ seasonId, clubId: fla, division: "A", ...BAND });
    await database.db
      .update(seasons)
      .set({ status: "ipo_open", offerSize: 3000, ipoOpensAt: OPENS_AT, ipoClosesAt: CLOSES_AT, firstKickoff: new Date("2027-04-11T19:00:00Z") })
      .where(eq(seasons.id, seasonId));
    [treasury] = (await openWallets(database.db, seasonId, [{ type: "treasury" }])) as [number];
  });
  afterAll(() => app?.close());

  it("a exclusão que leu ipo_open e esperou o fechamento fica para depois da liquidação (sem erro); a que passou na frente encerra na hora", async () => {
    const deletion = app.get(AccountDeletionService);
    const closing = app.get(IpoClosingService);
    const deferred: number[] = [];

    for (let round = 0; round < ROUNDS; round++) {
      await reopen();
      clock.set(DURING);
      const account = await createAccount(database.db);
      const [walletId] = (await openWallets(database.db, seasonId, [{ type: "user", userId: account.id }])) as [number];
      await app.get(IpoBidsService).place(walletId, "FLA3", { quantity: QTY, maxPrice: MAX_PRICE, expect: "new" });
      // O pedido de exclusão chega um segundo antes do fechamento; a tarefa de fechar roda no horário. (Pedido
      // no horário de fechamento ou depois já fica para depois da liquidação sem disputar a trava.)
      clock.set(new Date(CLOSES_AT.getTime() - 1000));

      const closeFirst = round % 2 === 0;
      const del = () => deletion.deleteAccount(account.id);
      const close = () => closing.closeIfDue(CLOSES_AT);
      const [r1, r2] = closeFirst ? await inLockOrder(close, del) : await inLockOrder(del, close);
      const [closed, deleted] = closeFirst ? [r1, r2] : [r2, r1];

      // Nenhum erro: a exclusão nunca é recusada pelo momento da temporada.
      expect("error" in deleted ? deleted.error : undefined, `rodada ${round}`).toBeUndefined();
      expect("value" in closed && closed.value, `rodada ${round}`).toMatchObject({ status: "closed" });
      expect((await database.db.select().from(users).where(eq(users.id, account.id)))[0]).toMatchObject({ status: "deleted", email: null });
      const [bid] = await database.db.select().from(ipoBids).where(eq(ipoBids.walletId, walletId));
      const [w] = await database.db.select().from(wallets).where(eq(wallets.id, walletId));

      if (closeFirst) {
        // O fechamento passou na frente: a oferta entra no rateio e a carteira espera a liquidação.
        expect("value" in deleted && deleted.value).toEqual({ walletCloseout: "after_ipo_settlement" });
        expect(bid).toMatchObject({ status: "active", reserved: QTY * MAX_PRICE });
        expect(w).toMatchObject({ cash: INITIAL_CASH, reservedCash: QTY * MAX_PRICE });
        deferred.push(walletId);
      } else {
        // A exclusão passou na frente, com o IPO ainda aberto: oferta cancelada e carteira encerrada.
        expect("value" in deleted && deleted.value).toEqual({ walletCloseout: "done" });
        expect(bid).toMatchObject({ status: "cancelled", reserved: 0 });
        expect(w).toMatchObject({ cash: 0, reservedCash: 0 });
      }
    }
    expect(deferred).toHaveLength(ROUNDS / 2);

    // Depois da liquidação, o account-closeout encerra as carteiras que ficaram para depois.
    expect(await app.get(IpoSettlementService).settleDue(SETTLE_AT)).toMatchObject({ status: "ran", failed: [], pending: 0 });
    expect(await deletion.closeoutPending()).toBe(ROUNDS / 2);
    for (const walletId of deferred) {
      expect((await database.db.select().from(wallets).where(eq(wallets.id, walletId)))[0]).toMatchObject({ cash: 0, reservedCash: 0 });
    }
    // A oferta inteira (3.000) e o lote ficam na tesouraria: as 1.000 atendidas voltaram pelo encerramento.
    const [t] = await database.db.select().from(positions).where(and(eq(positions.walletId, treasury), eq(positions.clubId, fla)));
    expect(t!.shares).toBe(3000 + 600);
    await assertLedgerConsistent(database.db, seasonId);
    await assertSharesConserved(database.db, seasonId);
  });
});
