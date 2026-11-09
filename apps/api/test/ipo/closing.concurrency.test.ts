import "reflect-metadata";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ipoDates } from "@futbolsa/engine";
import { Clock, FixedClock } from "../../src/infra/clock/index.js";
import { adminLog, ipoBids, seasonClubs, seasons, walletEntries, wallets } from "../../src/infra/db/schema/index.js";
import { DomainError } from "../../src/infra/http/index.js";
import { SeasonsService } from "../../src/modules/admin/seasons/seasons.service.js";
import { IpoBidsService, IpoClosingService, IpoEvents } from "../../src/modules/ipo/index.js";
import { PortfolioLedger } from "../../src/modules/portfolio/index.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { openPlayerWallets, rng, seedSeason, sleep } from "../support/fixtures.js";
import { assertLedgerConsistent } from "../support/invariants.js";

const noEvents = { seasonStatus: () => {}, posted: () => {} } as unknown as IpoEvents;

/** Cada cenário roda 20 vezes, como os testes das travas da F4. */
const ROUNDS = 20;
/** Faixa igual para todos os clubes: piso R$ 30, teto R$ 70. */
const BAND = { bandCenter: 5000, bandFloor: 3000, bandCeiling: 7000 };
const FIRST_KICKOFF = new Date("2027-04-11T19:00:00Z");
const DATES = ipoDates(FIRST_KICKOFF.getTime());
const CLOSES_AT = new Date(DATES.closesAt);

/**
 * Relógio que anda 1 ms a cada leitura: cada oferta lê o relógio depois da trava, então a ordem em que
 * as transações passam pela trava é a ordem dos horários, e a rodada atravessa o horário de fechamento.
 */
class TickingClock extends Clock {
  private current = 0;
  set(instant: Date): void {
    this.current = instant.getTime();
  }
  now(): Date {
    return new Date(this.current++);
  }
}

describe("fechamento do IPO sob concorrência, contra o Postgres", () => {
  const t = useTestDatabase(30);
  let seasonId: number;
  let clubIds: Map<string, number>;
  let tickers: string[];

  beforeAll(async () => {
    ({ seasonId, clubIds } = await seedSeason(t.db));
    tickers = [...clubIds.keys()].sort().slice(0, ROUNDS);
    expect(tickers).toHaveLength(ROUNDS);
    await t.db.insert(seasonClubs).values(tickers.map((ticker) => ({ seasonId, clubId: clubIds.get(ticker)!, division: "A", ...BAND })));
  });

  /** Reabre as ofertas com o fechamento original (o estado que a abertura deixa). */
  const reopen = () =>
    t.db
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
  const seasonRow = async () => (await t.db.select().from(seasons).where(eq(seasons.id, seasonId)))[0]!;

  /** O código da recusa de regra; qualquer outro erro (deadlock, trava fora de ordem) faz o teste falhar. */
  const outcome = (p: Promise<unknown>): Promise<string> =>
    p.then(
      () => "ok",
      (error: unknown) => {
        if (error instanceof DomainError) return error.code;
        throw error;
      },
    );

  describe("4. ofertas contra o fechamento", () => {
    const clock = new TickingClock();
    let bids: IpoBidsService;
    let closing: IpoClosingService;

    beforeAll(() => {
      // Os serviços como a aplicação monta, com o pool do arquivo: cada transação pega a sua conexão.
      bids = new IpoBidsService(t.db, new PortfolioLedger(), clock, noEvents);
      // O fechamento não grava no registro do admin: não precisa dele.
      closing = new IpoClosingService(t.db, clock, undefined as never, noEvents);
    });

    it("50 ofertas em volta de ipo_closes_at com a tarefa de fechar rodando: toda oferta gravada é de antes do fechamento, nenhuma depois, sem deadlock", async () => {
      const random = rng(4242);
      const walletIds = await openPlayerWallets(t.db, seasonId, 50);
      let accepted = 0;
      let refused = 0;
      for (let round = 0; round < ROUNDS; round++) {
        await reopen();
        const ticker = tickers[round]!;
        // A rodada começa 25 ms antes do fechamento; com uma leitura por oferta e as da tarefa, atravessa o horário.
        clock.set(new Date(CLOSES_AT.getTime() - 25));

        // A tarefa de fechar roda em volta, lendo o relógio da API a cada passada, até fechar.
        const passes: string[] = [];
        const job = (async () => {
          for (;;) {
            const result = await closing.closeIfDue(clock.now());
            passes.push(result.status);
            if (result.status === "closed") return;
          }
        })();
        // As 50 ofertas na ordem sorteada, de 1 a 10 ações até R$ 30 a R$ 90.
        const order = [...walletIds];
        for (let i = order.length - 1; i > 0; i--) {
          const j = Math.floor(random() * (i + 1));
          [order[i], order[j]] = [order[j]!, order[i]!];
        }
        const results = await Promise.all(
          order.map((walletId) =>
            outcome(
              bids.place(walletId, ticker, {
                quantity: 1 + Math.floor(random() * 10),
                maxPrice: 3000 + Math.floor(random() * 6000),
                expect: "new",
              }),
            ),
          ),
        );
        await job;

        for (const r of results) expect(["ok", "ipo_closed"]).toContain(r);
        expect(passes.filter((p) => p === "closed")).toHaveLength(1);
        expect((await seasonRow()).status).toBe("ipo_closed");

        const rows = await t.db
          .select()
          .from(ipoBids)
          .where(and(eq(ipoBids.seasonId, seasonId), eq(ipoBids.clubId, clubIds.get(ticker)!)));
        expect(rows).toHaveLength(results.filter((r) => r === "ok").length);
        for (const bid of rows) {
          expect(bid.status).toBe("active");
          expect(bid.updatedAt.getTime()).toBeLessThan(CLOSES_AT.getTime());
        }
        accepted += rows.length;
        refused += results.filter((r) => r === "ipo_closed").length;

        // Depois do fechamento, nenhuma oferta passa, nem com o relógio voltando para antes do horário.
        clock.set(new Date(CLOSES_AT.getTime() - 1000));
        expect(await outcome(bids.place(walletIds[0]!, ticker, { quantity: 1, maxPrice: 3000, expect: "new" }))).toBe("ipo_closed");
      }
      // A corrida aconteceu: houve ofertas dos dois lados do horário.
      expect(accepted).toBeGreaterThan(0);
      expect(refused).toBeGreaterThan(0);

      // A reserva de cada carteira é a soma das ofertas ativas e das linhas `ipo_reserve`.
      for (const walletId of walletIds) {
        const [w] = await t.db.select().from(wallets).where(eq(wallets.id, walletId));
        const [{ total }] = (await t.db
          .select({ total: sql<string>`coalesce(sum(${ipoBids.reserved}), 0)` })
          .from(ipoBids)
          .where(and(eq(ipoBids.walletId, walletId), eq(ipoBids.status, "active")))) as [{ total: string }];
        const [{ entries }] = (await t.db
          .select({ entries: sql<string>`coalesce(sum(${walletEntries.reservedCashDelta}), 0)` })
          .from(walletEntries)
          .where(and(eq(walletEntries.walletId, walletId), eq(walletEntries.kind, "ipo_reserve")))) as [{ entries: string }];
        expect(w!.reservedCash).toBe(Number(total));
        expect(Number(entries)).toBe(Number(total));
      }
    });
  });

  describe("5. adiar contra fechar", () => {
    const clock = new FixedClock(new Date(CLOSES_AT.getTime() - 1));
    let app: NestFastifyApplication;
    let closing: IpoClosingService;
    let seasonsService: SeasonsService;
    let admin: TestAccount;

    beforeAll(async () => {
      app = await createTestApp({ db: t.db, clock, override: withTestAuth(clock) });
      closing = app.get(IpoClosingService);
      seasonsService = app.get(SeasonsService, { strict: false });
      admin = await createAccount(t.db, { role: "admin" });
    });
    afterAll(() => app?.close());

    const postponeLogs = async () =>
      (
        await t.db
          .select({ n: sql<number>`count(*)::int` })
          .from(adminLog)
          .where(and(eq(adminLog.action, "season.ipo.postpone"), eq(adminLog.targetId, String(seasonId))))
      )[0]!.n;

    /** Espera até `n` conexões deste banco estarem paradas numa trava. */
    async function waitForLockWaiters(n: number) {
      for (let i = 0; i < 200; i++) {
        const res = await t.conn.pool.query(
          "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
        );
        if (res.rows[0].n >= n) return;
        await sleep(10);
      }
      throw new Error(`as ${n} transações não chegaram à trava da temporada`);
    }

    /**
     * Dispara as duas ao mesmo tempo com a temporada presa por uma transação de fora: a primeira chega à
     * trava, depois a segunda, e só então a de fora termina. A fila da trava da linha decide a ordem, então
     * cada lado da corrida acontece quando a rodada manda, sem depender do sorteio do escalonador.
     */
    async function inLockOrder<A, B>(first: () => Promise<A>, second: () => Promise<B>): Promise<[A, B]> {
      const gate = await t.conn.pool.connect();
      try {
        await gate.query("begin");
        await gate.query("select id from futbolsa.seasons where id = $1 for update", [seasonId]);
        const a = first();
        await waitForLockWaiters(1);
        const b = second();
        await waitForLockWaiters(2);
        await gate.query("commit");
        return [await a, await b];
      } finally {
        gate.release();
      }
    }

    it("o adiamento e a tarefa de fechar no mesmo instante: ou fechou (e o adiamento dá ipo_closed) ou adiou (e a tarefa não fecha), nunca os dois", async () => {
      const seen = { closed: 0, postponed: 0 };
      const postponed = new Date("2027-04-06T19:00:00Z");
      for (let round = 0; round < ROUNDS; round++) {
        await reopen();
        // O admin pede 1 ms antes do fechamento (o relógio lido depois da trava); a tarefa já passou do horário.
        clock.set(new Date(CLOSES_AT.getTime() - 1));
        const logsBefore = await postponeLogs();

        const patch = () =>
          outcome(seasonsService.patch(admin.id, seasonId, { ipoClosesAt: postponed.toISOString(), reason: `rodada ${round}` }));
        const close = () => closing.closeIfDue(CLOSES_AT).then((r) => r.status);
        // As rodadas pares com o fechamento na frente da fila da trava, as ímpares com o adiamento.
        const closeFirst = round % 2 === 0;
        const [patchResult, closeResult] = closeFirst
          ? await inLockOrder(close, patch).then(([c, p]) => [p, c] as const)
          : await inLockOrder(patch, close);
        expect(closeResult === "closed", `rodada ${round}`).toBe(closeFirst);

        const season = await seasonRow();
        const logs = (await postponeLogs()) - logsBefore;
        if (closeResult === "closed") {
          expect(patchResult).toBe("ipo_closed");
          expect(season.status).toBe("ipo_closed");
          expect(season.ipoClosesAt).toEqual(CLOSES_AT);
          expect(season.tradingOpensAt).toEqual(new Date(DATES.tradingOpensAt));
          expect(logs).toBe(0);
          seen.closed++;
        } else {
          expect(closeResult).toBe("idle");
          expect(patchResult).toBe("ok");
          expect(season.status).toBe("ipo_open");
          expect(season.ipoClosesAt).toEqual(postponed);
          expect(season.tradingOpensAt).toEqual(new Date("2027-04-07T13:00:00Z"));
          expect(logs).toBe(1);
          seen.postponed++;
        }
      }
      // Os dois lados da corrida, cada um em metade das rodadas (a ordem é forçada, não sorteada).
      expect(seen).toEqual({ closed: ROUNDS / 2, postponed: ROUNDS / 2 });
    });
  });

  it("invariantes: carteiras iguais à soma do extrato e nenhuma reserva acima do caixa", async () => {
    await assertLedgerConsistent(t.db, seasonId);
  });
});
