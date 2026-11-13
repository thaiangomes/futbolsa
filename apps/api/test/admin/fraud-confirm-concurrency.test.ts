import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixedClock } from "../../src/infra/clock/index.js";
import { fraudCases, fraudWarnings, positions, tradeAnnulments, trades, users, wallets } from "../../src/infra/db/schema/index.js";
import { AccountDeletionService } from "../../src/modules/accounts/index.js";
import { FraudDecisionService } from "../../src/modules/admin/fraud/decision.service.js";
import { BlockService } from "../../src/modules/admin/players/block.service.js";
import { displayedPrice, OrderService, RefreshService } from "../../src/modules/market/index.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { bearer, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import {
  assertCandlesMatchTrades,
  assertLedgerConsistent,
  assertOpenOrdersCounter,
  assertReservesMatchOrders,
  assertSharesConserved,
} from "../support/invariants.js";
import { marketSeason, type MarketSeason } from "../market/helpers.js";
import { accepted, barrier, giveCash, giveShares, openTreasury, orderInputs, syncTotalShares } from "../market/order-helpers.js";
import { ALL_TICKERS, brt, newPlayer, openCase, pairTrade } from "./fraud-decision-helpers.js";

// F14, T25 (concorrência): a confirmação do caso de trapaça contra uma ordem no mesmo clube, outro admin decidindo o
// mesmo caso, a exclusão ou o bloqueio de uma das contas e a reposição da casa. 10 repetições com barreira: a decisão
// espera depois da leitura sem trava (passo 1) até a outra transação chegar. Nunca *deadlock*, nunca negócio novo
// contra o preço velho, e as invariantes do dinheiro e das ações no fim.

const NOW = new Date("2027-08-05T15:00:00Z");
const REPS = 10;
const REASON = "negócios combinados entre as contas";

describe("decidir o caso de trapaça: concorrência", () => {
  const database = useTestDatabase(30);
  const clock = new FixedClock(NOW);
  let app: NestFastifyApplication;
  let s: MarketSeason;
  let admin: TestAccount;
  let token: string;
  let decisions: FraudDecisionService;
  let keys = 0;

  const club = (ticker: string) => s.clubIds.get(ticker)!;
  const player = () => newPlayer(database.db, s.seasonId);
  const shares = async (wallet: number, ticker: string, quantity: number) => {
    await giveShares(database.db, wallet, club(ticker), quantity);
    await syncTotalShares(database.db, s.seasonId);
  };
  const confirm = async (caseId: number, tradeIds: number[], as = token) =>
    app.inject({
      method: "POST",
      url: `/admin/fraud/cases/${caseId}/confirm`,
      headers: { ...bearer(as), "idempotency-key": `c-${++keys}` },
      payload: { tradeIds, reason: REASON },
    });

  /** Ana compra 3 de Bruno, 5% acima a cada dia (R$ 42,00, R$ 44,10 e R$ 46,31), e o caso manual do par. */
  const cheating = async (ticker: string, day = 21) => {
    const [ana, bruno] = [await player(), await player()];
    await shares(bruno.wallet, ticker, 10);
    const prices = [4200, 4410, 4631];
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(await pairTrade(database.db, s.seasonId, club(ticker), ticker, { buyer: ana.wallet, seller: bruno.wallet, at: brt(`2027-07-${day + i}`), price: prices[i]!, priceBefore: i === 0 ? 4000 : prices[i - 1]! }));
    }
    const caseId = await openCase(app, token, { userId: ana.account.id }, { userId: bruno.account.id }, { ticker });
    return { ana, bruno, ids, caseId };
  };
  const annulledCount = async (ids: number[]) => (await database.db.select().from(tradeAnnulments).where(inArray(tradeAnnulments.tradeId, ids))).length;

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    s = await marketSeason(database.db, { tickers: ALL_TICKERS });
    await openTreasury(database.db, s.seasonId);
    admin = await createAccount(database.db, { role: "admin" });
    token = await admin.tokenWith({ at: clock.now() });
    decisions = app.get(FraudDecisionService);
  });
  afterAll(async () => {
    decisions.hooks = {};
    await assertLedgerConsistent(database.db, s.seasonId);
    await assertSharesConserved(database.db, s.seasonId);
    await assertOpenOrdersCounter(database.db, s.seasonId);
    await assertReservesMatchOrders(database.db, s.seasonId);
    await assertCandlesMatchTrades(database.db, s.seasonId);
    await app?.close();
  });

  it("admin 42: confirmar com uma ordem chegando no mesmo clube: o negócio novo sai contra o preço velho ou contra o refeito, nunca no meio", async () => {
    const orders = app.get(OrderService);
    for (let i = 0; i < REPS; i++) {
      const ticker = ALL_TICKERS[i]!;
      const { ids, caseId } = await cheating(ticker);
      const [carla, dan] = [await player(), await player()];
      await shares(carla.wallet, ticker, 5);
      const input = orderInputs({ seasonId: s.seasonId, now: clock.now() });
      accepted(await orders.place(input.sellLimit(carla.wallet, ticker, 1, 4300)));
      const gate = barrier(2);
      decisions.hooks = { afterRead: gate };
      const [decided, bought] = await Promise.all([
        confirm(caseId, ids),
        (async () => {
          await gate();
          return orders.place(input.buyLimit(dan.wallet, ticker, 1, 4300));
        })(),
      ]);
      decisions.hooks = {};
      expect(decided.statusCode, decided.body).toBe(200);
      const trade = accepted(bought).trades[0]!;
      const [row] = await database.db.select().from(trades).where(eq(trades.id, trade.id));
      // antes da anulação, contra R$ 46,31; depois, contra os R$ 40,00 refeitos
      expect([4631, 4000]).toContain(row!.priceBefore);
      expect(await annulledCount(ids)).toBe(3);
      expect(await displayedPrice(database.db, s.seasonId, ticker)).toBe(4300);
    }
    await assertLedgerConsistent(database.db, s.seasonId);
    await assertSharesConserved(database.db, s.seasonId);
  });

  it("dois admins decidindo o mesmo caso: um passa e o outro recebe case_already_decided; anula uma vez só", async () => {
    const second = await createAccount(database.db, { role: "admin" });
    const secondToken = await second.tokenWith({ at: clock.now() });
    for (let i = 0; i < REPS; i++) {
      const { ana, ids, caseId } = await cheating("CRU3");
      const gate = barrier(2);
      decisions.hooks = { afterRead: gate };
      const results = await Promise.all([confirm(caseId, ids), confirm(caseId, ids, secondToken)]);
      decisions.hooks = {};
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      expect(results.find((r) => r.statusCode === 409)!.json().code).toBe("case_already_decided");
      expect(await annulledCount(ids)).toBe(3);
      expect(await database.db.select().from(fraudWarnings).where(eq(fraudWarnings.userId, ana.account.id))).toHaveLength(1);
    }
    // confirmar e descartar ao mesmo tempo: só uma decisão fica
    for (let i = 0; i < REPS; i++) {
      const { ids, caseId } = await cheating("CRU3");
      const [c, d] = await Promise.all([
        confirm(caseId, ids),
        app.inject({ method: "POST", url: `/admin/fraud/cases/${caseId}/dismiss`, headers: bearer(secondToken), payload: { reason: "foi coincidência" } }),
      ]);
      expect([c.statusCode, d.statusCode].sort()).toEqual([200, 409]);
      const [row] = await database.db.select().from(fraudCases).where(eq(fraudCases.id, caseId));
      expect(row!.status).toBe(c.statusCode === 200 ? "confirmed" : "dismissed");
      expect(await annulledCount(ids)).toBe(c.statusCode === 200 ? 3 : 0);
    }
  });

  it("confirmar com a exclusão ou o bloqueio de uma das contas: os dois passam, em qualquer ordem", async () => {
    const deletion = app.get(AccountDeletionService);
    const blocks = app.get(BlockService);
    const other = await createAccount(database.db, { role: "admin" });
    for (let i = 0; i < REPS; i++) {
      const { ana, bruno, ids, caseId } = await cheating("CAM3");
      const gate = barrier(2);
      decisions.hooks = { afterRead: gate };
      const deleteBruno = i % 2 === 0;
      const [decided] = await Promise.all([
        confirm(caseId, ids),
        (async () => {
          await gate();
          if (deleteBruno) await deletion.deleteAccount(bruno.account.id);
          else await blocks.block(other.id, ana.account.id, "bloqueio durante a decisão");
        })(),
      ]);
      decisions.hooks = {};
      expect(decided.statusCode, decided.body).toBe(200);
      expect(await annulledCount(ids)).toBe(3);
      if (deleteBruno) {
        // a conta excluída fica sem ações: as que voltaram foram para a tesouraria, antes ou depois da exclusão
        const left = await database.db.select({ shares: positions.shares }).from(positions).where(eq(positions.walletId, bruno.wallet));
        expect(left.every((p) => p.shares === 0)).toBe(true);
        expect(await database.db.select().from(fraudWarnings).where(eq(fraudWarnings.userId, ana.account.id))).toHaveLength(1);
      } else {
        const [u] = await database.db.select({ status: users.status }).from(users).where(eq(users.id, ana.account.id));
        expect(u!.status).toBe("blocked");
      }
    }
    await assertLedgerConsistent(database.db, s.seasonId);
    await assertSharesConserved(database.db, s.seasonId);
  });

  it("confirmar com a reposição da casa no mesmo clube: as duas passam e a tesouraria nunca fica com ações livres negativas", async () => {
    const refresh = app.get(RefreshService);
    const [{ id: treasury }] = (await database.db
      .select({ id: wallets.id })
      .from(wallets)
      .where(and(eq(wallets.seasonId, s.seasonId), eq(wallets.ownerType, "treasury")))) as [{ id: number }];
    await giveCash(database.db, treasury, 100_000_000);
    await shares(treasury, "BAH3", 1_000);
    for (let i = 0; i < REPS; i++) {
      const { ids, caseId } = await cheating("BAH3");
      const gate = barrier(2);
      decisions.hooks = { afterRead: gate };
      const [decided] = await Promise.all([
        confirm(caseId, ids),
        refresh.refreshClub(s.seasonId, "BAH3", clock.now(), { fairValues: new Map([["BAH3", 4000]]), inMatch: false, beforeClubLock: gate }),
      ]);
      decisions.hooks = {};
      expect(decided.statusCode, decided.body).toBe(200);
      expect(await annulledCount(ids)).toBe(3);
      const [vault] = await database.db.select().from(positions).where(and(eq(positions.walletId, treasury), eq(positions.clubId, club("BAH3"))));
      expect(vault!.shares - vault!.reservedShares).toBeGreaterThanOrEqual(0);
    }
    await assertReservesMatchOrders(database.db, s.seasonId);
  });

});
