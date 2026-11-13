import "reflect-metadata";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { FixedClock } from "../../src/infra/clock/index.js";
import { lockClubs, lockSeason, withTransaction } from "../../src/infra/db/index.js";
import { AccountDeletionService } from "../../src/modules/accounts/index.js";
import { SuspensionService } from "../../src/modules/admin/suspension/suspension.service.js";
import { EndTradingService } from "../../src/modules/market/index.js";
import { createAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { withTestAuth } from "../support/auth.js";
import { countingDatabase } from "../support/counting-db.js";
import { useTestDatabase } from "../support/db.js";
import { deferred, rng, T0 } from "../support/fixtures.js";
import { assertLedgerConsistent, assertSharesConserved, totalCash } from "../support/invariants.js";
import { assertMarketInvariants, giveShares, openPlayer, orderInputs, orderService, syncTotalShares } from "../market/order-helpers.js";
import { entryWorld, useEntryApp } from "./support.js";

const ENTRIES = 30;
const ORDERS = 300;

/** Entradas ao mesmo tempo com ordens reais da F9, em 3 e em 22 clubes (semente fixa). */
describe.each([3, 22])("entradas junto com ordens, com %i clubes", (clubs) => {
  const e = useEntryApp({ clubs, poolSize: 30 });

  it("30 entradas (índice e só caixa) com 300 ordens: nenhuma repetição esgotada e todas as invariantes de pé", async () => {
    const { world } = e;
    const traders: number[] = [];
    for (let i = 0; i < 12; i++) traders.push(await openPlayer(e.db, world.seasonId, 10_000_000));
    for (const t of traders) for (const ticker of world.tickers) await giveShares(e.db, t, world.clubIds.get(ticker)!, 100, 2400);
    await syncTotalShares(e.db, world.seasonId);
    const cashBefore = await totalCash(e.db, world.seasonId);

    const { service: orders } = orderService(e.db);
    const input = orderInputs({ seasonId: world.seasonId, now: T0 });
    const random = rng(2027 + clubs);
    let orderRetries = 0;
    let entryRetries = 0;
    const placing = Array.from({ length: ORDERS }, (_, i) => {
      const trader = traders[Math.floor(random() * traders.length)]!;
      const ticker = world.tickers[Math.floor(random() * world.tickers.length)]!;
      const quantity = 1 + Math.floor(random() * 20);
      const price = 2300 + 10 * Math.floor(random() * 20);
      const make = i % 2 === 0 ? input.buyLimit : input.sellLimit;
      return orders.place(make(trader, ticker, quantity, price), { transaction: { onRetry: () => orderRetries++ } });
    });
    const owners = await Promise.all(Array.from({ length: ENTRIES }, () => e.newOwner()));
    const entering = owners.map((owner, i) =>
      e.service.enter(owner, i % 2 === 0 ? "index" : "cash", { transaction: { onRetry: () => entryRetries++ } }),
    );
    const outcomes = await Promise.all(entering);
    await Promise.all(placing);

    expect(outcomes.every((o) => o.created)).toBe(true);
    expect(orderRetries).toBe(0);
    expect(entryRetries).toBe(0);
    // o dinheiro novo do jogo é só o caixa com que cada novato fica (índice: R$ 100.000,00 menos o que "pagou" pelas ações emitidas)
    const created = outcomes.reduce((acc, o) => acc + o.result.cash, 0);
    await assertMarketInvariants(e.db, world.seasonId, cashBefore + created);
  });
});

describe("entradas e conexões", () => {
  const database = useTestDatabase(30);
  const clock = new FixedClock(T0);

  it("30 entradas ao mesmo tempo usam no máximo uma transação (uma conexão) por vez, e a fila cheia recebe entry_busy", async () => {
    await entryWorld(database.db, { clubs: 20 });
    const counting = countingDatabase(database.conn.pool);
    const app = await createTestApp({ db: counting.db, clock });
    try {
      const { EntryService } = await import("../../src/modules/entry/enter.service.js");
      const service = app.get(EntryService);
      const owners = await Promise.all(Array.from({ length: ENTRIES }, async () => ({ type: "user" as const, userId: (await createAccount(database.db)).id, status: "active" })));
      const mark = counting.mark();
      await Promise.all(owners.map((o) => service.enter(o, "index")));
      let open = 0;
      let peak = 0;
      for (const s of counting.since(mark)) {
        if (/^\s*begin/i.test(s)) peak = Math.max(peak, ++open);
        else if (/^\s*(commit|rollback)\s*$/i.test(s)) open--;
      }
      expect(peak).toBe(1);

      // a fila: 1 rodando + 50 esperando; a 52ª recebe entry_busy
      const many = await Promise.all(Array.from({ length: 70 }, async () => ({ type: "user" as const, userId: (await createAccount(database.db)).id, status: "active" })));
      const results = await Promise.allSettled(many.map((o) => service.enter(o, "index")));
      const busy = results.filter((r) => r.status === "rejected" && (r.reason as { code?: string }).code === "entry_busy");
      expect(busy.length).toBeGreaterThan(0);
      expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(51);
      for (const r of results) if (r.status === "rejected") expect((r.reason as { status: number }).status).toBe(503);
    } finally {
      await app.close();
    }
  });
});

describe("a trava que não sai", () => {
  const e = useEntryApp({ clubs: 20 });

  it("outra transação segura um clube: a entrada responde entry_busy em ~5 s e nada é gravado", async () => {
    const owner = await e.newOwner();
    const held = deferred();
    const released = deferred();
    const holder = withTransaction(e.db, async (tx) => {
      await lockSeason(tx, e.world.seasonId, "share");
      await lockClubs(tx, e.world.seasonId, [e.world.tickers.slice().sort()[5]!]);
      held.resolve();
      await released.promise;
    });
    await held.promise;
    const before = (await e.db.execute(sql`select (select count(*) from futbolsa.wallets) as w, (select sum(total_shares) from futbolsa.season_clubs) as s`)).rows[0];
    const started = Date.now();
    await expect(e.service.enter(owner, "index")).rejects.toMatchObject({ code: "entry_busy", status: 503 });
    const elapsed = Date.now() - started;
    released.resolve();
    await holder;
    expect(elapsed).toBeGreaterThanOrEqual(4_500);
    expect(elapsed).toBeLessThan(9_000);
    expect((await e.db.execute(sql`select (select count(*) from futbolsa.wallets) as w, (select sum(total_shares) from futbolsa.season_clubs) as s`)).rows[0]).toEqual(before);
    // solta a trava e a mesma pessoa entra
    expect((await e.service.enter(owner, "index")).created).toBe(true);
  }, 30_000);
});

describe("entradas contra o fim da negociação e a suspensão do mercado", () => {
  const e = useEntryApp({ clubs: 20, poolSize: 30 });

  it("fim da negociação disputando com entradas: ninguém trava, e depois dele vem entry_window_closed", async () => {
    const ending = e.app.get(EndTradingService);
    const owners = await Promise.all(Array.from({ length: 12 }, () => e.newOwner()));
    const attempts = owners.map((o) => e.service.enter(o, "index").then((r) => r, (error: { code: string }) => error));
    const end = withTransaction(e.db, (tx) => ending.endTrading(tx, new Date(T0.getTime() + 3_600_000), { seasonId: e.world.seasonId }));
    const [results] = await Promise.all([Promise.all(attempts), end]);
    const created = results.filter((r) => "created" in r).length;
    for (const r of results) if (!("created" in r)) expect(r.code).toBe("entry_window_closed");
    const n = ((await e.db.execute(sql`select count(*)::int as n from futbolsa.wallets where owner_type = 'user'`)).rows[0] as { n: number }).n;
    expect(n).toBe(created);
    await expect(e.service.enter(await e.newOwner(), "index")).rejects.toMatchObject({ code: "entry_window_closed" });
    await assertSharesConserved(e.db, e.world.seasonId);
    await assertLedgerConsistent(e.db, e.world.seasonId);
  });
});

describe("entradas contra a suspensão do mercado todo", () => {
  const e = useEntryApp({ clubs: 20, poolSize: 30 });

  it("quem entra durante a suspensão ou depois dela recebe market_suspended; as demais ficam inteiras", async () => {
    const admin = await createAccount(e.db, { role: "admin" });
    const suspension = e.app.get(SuspensionService);
    const owners = await Promise.all(Array.from({ length: 12 }, () => e.newOwner()));
    const attempts = owners.map((o) => e.service.enter(o, "index").then((r) => r, (error: { code: string }) => error));
    const suspend = suspension.suspend(admin.id, { reason: "preço errado" });
    const [results] = await Promise.all([Promise.all(attempts), suspend]);
    const created = results.filter((r) => "created" in r).length;
    for (const r of results) if (!("created" in r)) expect(r.code).toBe("market_suspended");
    const n = ((await e.db.execute(sql`select count(*)::int as n from futbolsa.wallets where owner_type = 'user'`)).rows[0] as { n: number }).n;
    expect(n).toBe(created);
    await expect(e.service.enter(await e.newOwner(), "index")).rejects.toMatchObject({ code: "market_suspended" });
    await assertSharesConserved(e.db, e.world.seasonId);
    await assertLedgerConsistent(e.db, e.world.seasonId);
  });
});

describe("a conta excluída durante a entrada", () => {
  const database = useTestDatabase(30);
  const clock = new FixedClock(T0);

  it("a carteira criada na corrida é encerrada pelo fechamento pendente: ações para a tesouraria e invariantes de pé", async () => {
    const world = await entryWorld(database.db, { clubs: 20 });
    const app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    try {
      const { EntryService } = await import("../../src/modules/entry/enter.service.js");
      const service = app.get(EntryService);
      const deletion = app.get(AccountDeletionService);
      for (let round = 0; round < 6; round++) {
        const account = await createAccount(database.db);
        const owner = { type: "user" as const, userId: account.id, status: "active" };
        await Promise.allSettled([service.enter(owner, "index"), deletion.deleteAccount(account.id)]);
        await deletion.closeoutPending();
      }
      await deletion.closeoutPending();
      await assertSharesConserved(database.db, world.seasonId);
      await assertLedgerConsistent(database.db, world.seasonId);
      // nenhuma carteira de conta excluída guarda ações
      const rows = (await database.db.execute(sql`
        select count(*)::int as n from futbolsa.positions p
        join futbolsa.wallets w on w.id = p.wallet_id
        join futbolsa.users u on u.id = w.user_id
        where u.status = 'deleted' and p.shares > 0`)).rows as { n: number }[];
      expect(rows[0]!.n).toBe(0);
    } finally {
      await app.close();
    }
  }, 60_000);
});
