import { and, eq, sql } from "drizzle-orm";
import { expect } from "vitest";
import type { Database } from "../../src/infra/db/client.js";
import { lockWallets, withTransaction } from "../../src/infra/db/index.js";
import { bots, orders, positions, seasonClubs, wallets } from "../../src/infra/db/schema/index.js";
import {
  OrderService,
  PostgresMatchingEngine,
  type PlaceOrderAccepted,
  type PlaceOrderInput,
  type PlaceOrderRejected,
  type PlaceOrderResult,
} from "../../src/modules/market/index.js";
import { PortfolioLedger } from "../../src/modules/portfolio/index.js";
import { post } from "../../src/modules/portfolio/ledger/index.js";
import { createUser, openWallets, sleep, T0 } from "../support/fixtures.js";
import {
  assertBookNotCrossed,
  assertLedgerConsistent,
  assertOpenOrdersCounter,
  assertReservesMatchOrders,
  assertSharesConserved,
  totalCash,
} from "../support/invariants.js";

/** Ajudantes dos testes do motor de ordens (T4 em diante): montar carteiras, ações e preços, e conferir o resultado. */

/** O serviço de ordens como o Nest o monta, com o motor do Postgres à mão para os testes mexerem nas páginas. */
export function orderService(db: Database): { service: OrderService; engine: PostgresMatchingEngine } {
  const engine = new PostgresMatchingEngine(new PortfolioLedger());
  return { service: new OrderService(db, engine), engine };
}

/** A carteira da tesouraria (a casa), com caixa para as compras dela. */
export async function openTreasury(db: Database, seasonId: number, cash = 0): Promise<number> {
  const [treasury] = await openWallets(db, seasonId, [{ type: "treasury" }]);
  if (cash > 0) await giveCash(db, treasury!, cash);
  return treasury!;
}

/** Uma carteira de jogador com o caixa dado, em centavos. */
export async function openPlayer(db: Database, seasonId: number, cash: number): Promise<number> {
  const [wallet] = await openWallets(db, seasonId, [{ type: "user", userId: await createUser(db) }], cash);
  return wallet!;
}

/** Uma carteira de bot (perfil `trader`, ligado) com o caixa dado. */
export async function openBot(db: Database, seasonId: number, cash: number): Promise<number> {
  const [bot] = await db.insert(bots).values({ profile: "trader", active: true }).returning({ id: bots.id });
  const [wallet] = await openWallets(db, seasonId, [{ type: "bot", botId: bot!.id }], cash);
  return wallet!;
}

/** Caixa a mais numa carteira, por um ajuste do admin (o único movimento que cria dinheiro fora do IPO). */
export async function giveCash(db: Database, walletId: number, amount: number): Promise<void> {
  await withTransaction(db, async (tx) => {
    await lockWallets(tx, [walletId]);
    await post(tx, { walletId, at: T0, kind: "adjustment", cashDelta: amount, reason: "caixa do teste" });
  });
}

/** Caixa negativo por estorno de dividendo (Admin, critério 15): o único jeito de o caixa passar de zero para baixo. */
export async function reverseCash(db: Database, walletId: number, clubId: number, amount: number): Promise<void> {
  await withTransaction(db, async (tx) => {
    await lockWallets(tx, [walletId]);
    await post(tx, { walletId, at: T0, kind: "reversal", clubId, cashDelta: -amount, reason: "estorno do teste" });
  });
}

/** Ações numa carteira, como a liquidação do IPO as entrega (custo pelo preço dado). */
export async function giveShares(db: Database, walletId: number, clubId: number, quantity: number, price = 4000): Promise<void> {
  await withTransaction(db, async (tx) => {
    await lockWallets(tx, [walletId]);
    await post(tx, { walletId, at: T0, kind: "ipo_settle", clubId, sharesDelta: quantity, price, costBasis: "purchase" });
  });
}

/**
 * Fecha a montagem do teste: as ações de cada clube (`total_shares`) passam a ser a soma das que foram entregues.
 * Dali em diante o motor só troca ações de mão, e `assertSharesConserved` confere o critério 30.
 */
export async function syncTotalShares(db: Database, seasonId: number): Promise<void> {
  await db.execute(sql`
    update futbolsa.season_clubs sc
    set total_shares = coalesce((
      select sum(p.shares) from futbolsa.positions p
      join futbolsa.wallets w on w.id = p.wallet_id
      where w.season_id = sc.season_id and p.club_id = sc.club_id), 0)
    where sc.season_id = ${seasonId}`);
}

/** O preço exibido de um clube gravado à mão (o preço "andou" sem o teste ter de montar os negócios). */
export async function setDisplayedPrice(db: Database, seasonId: number, clubId: number, price: number): Promise<void> {
  await db.update(seasonClubs).set({ lastPrice: price }).where(and(eq(seasonClubs.seasonId, seasonId), eq(seasonClubs.clubId, clubId)));
}

class RolledBack extends Error {}

/**
 * Roda `body` dentro de uma transação que é sempre desfeita no fim, para um teste não deixar nada para o seguinte
 * (o extrato e os negócios são histórico: o banco não deixa apagar nem com `TRUNCATE`, e criar um banco por teste
 * custa uns 2 segundos). `body` recebe a transação no lugar do banco: cada `withTransaction` feito com ela vira um
 * ponto de salvamento, que confirma ou desfaz como uma transação comum. Só serve a testes em sequência, numa conexão.
 */
export async function rolledBack(db: Database, body: (inner: Database) => Promise<void>): Promise<void> {
  try {
    await db.transaction(async (outer) => {
      await body(outer as unknown as Database);
      throw new RolledBack();
    });
  } catch (error) {
    if (!(error instanceof RolledBack)) throw error;
  }
}

/**
 * Espera até `count` conexões deste banco estarem paradas numa trava: o teste de concorrência só segue quando a
 * outra transação já está esperando, sem depender de um tempo fixo.
 */
export async function waitForBlocked(db: Database, count = 1): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt++) {
    const result = await db.execute(
      sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if (Number(result.rows[0]!.n) >= count) return;
    await sleep(5);
  }
  throw new Error(`esperava ${count} transação(ões) parada(s) numa trava, e nenhuma ficou`);
}

/** A ordem foi aceita: devolve o resultado já com o tipo certo. */
export function accepted(result: PlaceOrderResult): PlaceOrderAccepted {
  if (!result.ok) throw new Error(`a ordem devia ser aceita e foi recusada: ${result.code}${result.reason ? ` (${result.reason})` : ""}`);
  return result;
}

/** A ordem foi recusada: devolve a recusa. */
export function rejected(result: PlaceOrderResult): PlaceOrderRejected {
  if (result.ok) throw new Error(`a ordem devia ser recusada e foi aceita (ordem ${result.order.id})`);
  return result;
}

/** Atalhos para montar a entrada de uma ordem de jogador. */
export function orderInputs(base: { seasonId: number; now: Date }) {
  const make =
    (side: "buy" | "sell", type: "limit" | "market") =>
    (walletId: number, ticker: string, quantity: number, limitPrice?: number, extra: Partial<PlaceOrderInput> = {}): PlaceOrderInput => ({
      seasonId: base.seasonId,
      now: base.now,
      ticker,
      walletId,
      actor: "player",
      side,
      type,
      quantity,
      ...(type === "limit" ? { limitPrice } : {}),
      ...extra,
    });
  return { buyLimit: make("buy", "limit"), sellLimit: make("sell", "limit"), buyMarket: make("buy", "market"), sellMarket: make("sell", "market") };
}

export async function walletOf(db: Database, walletId: number) {
  const [row] = await db.select().from(wallets).where(eq(wallets.id, walletId));
  return { cash: row!.cash, reservedCash: row!.reservedCash, free: row!.cash - row!.reservedCash, openOrders: row!.openOrders };
}

export async function positionOf(db: Database, walletId: number, clubId: number) {
  const [row] = await db.select().from(positions).where(and(eq(positions.walletId, walletId), eq(positions.clubId, clubId)));
  return { shares: row?.shares ?? 0, reservedShares: row?.reservedShares ?? 0, free: (row?.shares ?? 0) - (row?.reservedShares ?? 0) };
}

export async function orderRow(db: Database, orderId: number) {
  const [row] = await db.select().from(orders).where(eq(orders.id, orderId));
  return row!;
}

export async function clubRow(db: Database, seasonId: number, clubId: number) {
  const [row] = await db.select().from(seasonClubs).where(and(eq(seasonClubs.seasonId, seasonId), eq(seasonClubs.clubId, clubId)));
  return row!;
}

/** Quantas linhas há em `orders`, `trades` e no extrato: a recusa não pode mudar nenhuma. */
export async function rowCounts(db: Database): Promise<{ orders: number; trades: number; entries: number }> {
  const result = await db.execute(sql`
    select (select count(*) from futbolsa.orders)::int as orders,
           (select count(*) from futbolsa.trades)::int as trades,
           (select count(*) from futbolsa.wallet_entries)::int as entries`);
  const row = result.rows[0]!;
  return { orders: Number(row.orders), trades: Number(row.trades), entries: Number(row.entries) };
}

/**
 * As invariantes depois de um teste de dinheiro (critério 30 e "Testes" do plano): extrato igual às carteiras,
 * ações conservadas, caixa total igual ao de antes, nenhum livro cruzado, `open_orders` e reservas iguais ao livro.
 */
export async function assertMarketInvariants(db: Database, seasonId: number, cashBefore: number): Promise<void> {
  await assertLedgerConsistent(db, seasonId);
  await assertSharesConserved(db, seasonId);
  expect(await totalCash(db, seasonId)).toBe(cashBefore);
  await assertBookNotCrossed(db, seasonId);
  await assertOpenOrdersCounter(db, seasonId);
  await assertReservesMatchOrders(db, seasonId);
}
