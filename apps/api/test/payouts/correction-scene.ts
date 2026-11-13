import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, asc, eq, sql } from "drizzle-orm";
import { CLUBS } from "@futbolsa/engine";
import type { FixedClock } from "../../src/infra/clock/index.js";
import { type Database, lockWallets, type Tx, withTransaction } from "../../src/infra/db/index.js";
import {
  bots,
  matches,
  orders,
  payoutCredits,
  payoutEvents,
  payoutHoldings,
  seasonClubs,
  seasons,
  walletEntries,
  wallets,
} from "../../src/infra/db/schema/index.js";
import { DomainError } from "../../src/infra/http/index.js";
import { ApproveService } from "../../src/modules/admin/payouts/approve.service.js";
import { CloseEventsService } from "../../src/modules/admin/payouts/close-events.service.js";
import { CorrectionPlanService } from "../../src/modules/admin/payouts/correction-plan.js";
import { type PayoutsChange, RankingsPort } from "../../src/modules/admin/payouts/ports.js";
import { SettleCreditsService } from "../../src/modules/admin/payouts/settle-credits.js";
import { SeasonValuesService } from "../../src/modules/dividends/season-values/season-values.service.js";
import { OrderService, type PlaceOrderResult, RefreshWaker } from "../../src/modules/market/index.js";
import { PortfolioLedger } from "../../src/modules/portfolio/index.js";
import type { Movement } from "../../src/modules/portfolio/ledger/index.js";
import { post } from "../../src/modules/portfolio/ledger/index.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { listClubs, openWallets, seedSeason, T0 } from "../support/fixtures.js";

/**
 * O cenário dos testes da correção aplicada (T7): temporadas novas com os 18 clubes listados, jogadores e bots com
 * ações compradas da tesouraria pelo extrato, a rodada 10 do critério 12 e a aprovação de verdade (`ApproveService` e
 * `SettleCreditsService`). As compras e vendas abertas passam pelo `OrderService` da F9.
 */

export const MIN = 60_000;
export const TOTAL = 10_000;
/** Todos os clubes do seed menos JUV3 e RBB3, que ficam fora da lista da temporada. */
export const UNLISTED = ["JUV3", "RBB3"];
export const LISTED = CLUBS.map((c) => c.id).filter((t) => !UNLISTED.includes(t));
/** Preço de R$ 1,00 por ação nos negócios de teste com a tesouraria. */
export const PRICE = 100;
/** R$ 100.000,00. */
export const RICH = 10_000_000;

export const at = (iso: string) => new Date(iso);
export const after = (d: Date, minutes: number) => new Date(d.getTime() + minutes * MIN);

/** A rodada 10 do critério 12: 10 jogos, o último (JUV3 × RBB3) terminando às 20h (UTC) de 06/06/2027. */
export const ROUND10_CLOSE = at("2027-06-06T20:00:00Z");

/** Tabela onde o `RankingsPort` de teste grava pelo `tx` que recebe: some se a transação desfaz. */
export const CALLS = sql.raw("public.test_port_calls");

/** O `RankingsPort` de teste: grava o aviso pelo `tx` e, no `wake()`, quantos avisos já se veem de fora. */
export class RecordingRankings extends RankingsPort {
  readonly changes: PayoutsChange[] = [];
  readonly wakes: Array<{ recorded: number; visible: number }> = [];
  db!: Database;

  async payoutsChanged(tx: Tx, change: PayoutsChange): Promise<void> {
    await tx.db.execute(
      sql`insert into ${CALLS} (port, season_id, payload) values ('rankings', ${change.seasonId}, ${JSON.stringify(change.closedAts.map((d) => d.toISOString()))}::jsonb)`,
    );
    this.changes.push(change);
  }

  async wake(): Promise<void> {
    const { rows } = await this.db.execute(sql`select count(*)::int as n from ${CALLS} where port = 'rankings'`);
    this.wakes.push({ recorded: this.changes.length, visible: Number(rows[0]!.n) });
  }

  reset(): void {
    this.changes.length = 0;
    this.wakes.length = 0;
  }
}

/** O livro das carteiras de verdade, que pode falhar a partir do N-ésimo lançamento (a API que cai no meio). */
export class FlakyLedger extends PortfolioLedger {
  failFrom: number | null = null;
  posts = 0;

  post(tx: Tx, movement: Movement) {
    this.posts++;
    if (this.failFrom !== null && this.posts >= this.failFrom) throw new Error("falha de teste no meio da liquidação");
    return super.post(tx, movement);
  }
}

/**
 * A reposição da casa não acorda nos testes da correção: sem cotações da casa no livro, as compras e vendas dos
 * jogadores ficam abertas (ou casam só entre elas), e o estorno é o que muda o caixa. Os pedidos continuam gravados.
 */
export class SilentWaker extends RefreshWaker {
  override async wake(): Promise<void> {}
}

export interface Season {
  seasonId: number;
  treasury: number;
}

type MatchInsert = typeof matches.$inferInsert;

export async function prepareCalls(db: Database): Promise<void> {
  await db.execute(sql`create table if not exists ${CALLS} (id serial primary key, port text not null, season_id int, payload jsonb)`);
}

export function correctionScene(db: () => Database, app: () => NestFastifyApplication, clock: FixedClock, firstYear = 2030) {
  let clubIds = new Map<string, number>();
  let year = firstYear;
  let admin: TestAccount;

  const club = (ticker: string) => clubIds.get(ticker)!;
  const service = <T>(type: abstract new (...args: never[]) => T): T => app().get(type as never, { strict: false }) as T;

  /** Antes de tudo: os clubes do seed e o admin. */
  async function init(): Promise<TestAccount> {
    ({ clubIds } = await seedSeason(db(), firstYear - 1));
    admin = await createAccount(db(), { role: "admin" });
    return admin;
  }

  /**
   * Uma temporada nova (a mais nova de todas, então é a atual), já em negociação: os 18 clubes listados a R$ 40,00, os
   * valores padrão e a tesouraria com as ações.
   */
  async function newSeason(): Promise<Season> {
    const { seasonId } = await seedSeason(db(), year++);
    await listClubs(db(), seasonId, clubIds, LISTED, TOTAL);
    await db().update(seasons).set({ status: "trading", tradingOpensAt: T0 }).where(eq(seasons.id, seasonId));
    const values = service(SeasonValuesService);
    await withTransaction(db(), (tx) => values.createInitial(tx, seasonId).then(() => undefined));
    const [treasury] = await openWallets(db(), seasonId, [{ type: "treasury" }]);
    await withTransaction(db(), async (tx) => {
      await lockWallets(tx, [treasury!]);
      for (const ticker of LISTED) {
        await post(tx, { walletId: treasury!, at: T0, kind: "adjustment", clubId: club(ticker), sharesDelta: TOTAL, price: 4000, costBasis: "purchase", reason: "emissão" });
      }
    });
    return { seasonId, treasury: treasury! };
  }

  /** Um jogador (ativo, bloqueado ou de conta excluída) com o caixa inicial dado. */
  async function player(s: Season, cash = RICH, status: "active" | "blocked" | "deleted" = "active"): Promise<number> {
    const account = await createAccount(db(), { status });
    const [id] = await openWallets(db(), s.seasonId, [{ type: "user", userId: account.id }], cash);
    return id!;
  }

  async function bot(s: Season, cash = RICH): Promise<number> {
    const [row] = await db().insert(bots).values({ profile: "dividendos", active: true }).returning({ id: bots.id });
    const [id] = await openWallets(db(), s.seasonId, [{ type: "bot", botId: row!.id }], cash);
    return id!;
  }

  /** A carteira compra ações da tesouraria a R$ 1,00 no instante dado (pelo extrato, como um negócio). */
  async function buy(s: Season, walletId: number, ticker: string, shares: number, when: Date = T0) {
    await withTransaction(db(), async (tx) => {
      await lockWallets(tx, [s.treasury, walletId]);
      await post(tx, { walletId: s.treasury, at: when, kind: "trade", clubId: club(ticker), sharesDelta: -shares, cashDelta: shares * PRICE, price: PRICE, costBasis: "sale" });
      await post(tx, { walletId, at: when, kind: "trade", clubId: club(ticker), sharesDelta: shares, cashDelta: -shares * PRICE, price: PRICE, costBasis: "purchase" });
    });
  }

  /** Uma carteira passa ações a outra no instante dado. */
  async function transfer(from: number, to: number, ticker: string, shares: number, when: Date) {
    await withTransaction(db(), async (tx) => {
      await lockWallets(tx, [from, to]);
      await post(tx, { walletId: from, at: when, kind: "trade", clubId: club(ticker), sharesDelta: -shares, cashDelta: shares * PRICE, price: PRICE, costBasis: "sale" });
      await post(tx, { walletId: to, at: when, kind: "trade", clubId: club(ticker), sharesDelta: shares, cashDelta: -shares * PRICE, price: PRICE, costBasis: "purchase" });
    });
  }

  /**
   * O preço exibido do clube (a faixa de 20% das ordens novas parte dele) e a referência do túnel no mesmo valor, com o
   * dia da referência bem no futuro, para ela não virar no meio do teste (um negócio a esse preço não abre leilão).
   */
  async function setLastPrice(s: Season, ticker: string, price: number) {
    await db()
      .update(seasonClubs)
      .set({ lastPrice: price, tunnelRef: price, tunnelRefDay: new Date("2100-01-01T03:00:00Z") })
      .where(and(eq(seasonClubs.seasonId, s.seasonId), eq(seasonClubs.clubId, club(ticker))));
  }

  /** Uma ordem limitada de jogador pelo `OrderService` da F9, no instante dado. */
  function place(s: Season, walletId: number, ticker: string, side: "buy" | "sell", quantity: number, limitPrice: number, now: Date): Promise<PlaceOrderResult> {
    return service(OrderService).place({ seasonId: s.seasonId, ticker, walletId, actor: "player", side, type: "limit", quantity, limitPrice, now });
  }

  /** Como `place`, exigindo que a ordem entre (e devolvendo o id dela). */
  async function placeOk(s: Season, walletId: number, ticker: string, side: "buy" | "sell", quantity: number, limitPrice: number, now: Date): Promise<number> {
    const r = await place(s, walletId, ticker, side, quantity, limitPrice, now);
    if (!r.ok) throw new Error(`ordem recusada: ${r.code}`);
    return r.order.id;
  }

  const game = (seasonId: number, round: number, home: string, away: string, score: [number, number], kickoff: Date): MatchInsert => ({
    seasonId,
    competition: "brasileirao-a",
    round,
    homeClubId: club(home),
    awayClubId: club(away),
    kickoff,
    finishedAt: new Date(kickoff.getTime() + 120 * MIN),
    homeGoals: score[0],
    awayGoals: score[1],
    status: "finished",
  });

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
      game(seasonId, 10, home, away, score, new Date(ROUND10_CLOSE.getTime() - 120 * MIN - (9 - i) * 10 * MIN)),
    );
  };
  const insertMatches = (rows: MatchInsert[]) => db().insert(matches).values(rows).returning();
  const matchOf = async (seasonId: number, home: string) =>
    (await db().select().from(matches).where(and(eq(matches.seasonId, seasonId), eq(matches.homeClubId, club(home)))))[0]!;
  const setScore = async (seasonId: number, home: string, score: [number, number]) =>
    db().update(matches).set({ homeGoals: score[0], awayGoals: score[1] }).where(eq(matches.id, (await matchOf(seasonId, home)).id));

  const close = (seasonId: number, now: Date) => {
    clock.set(now);
    return service(CloseEventsService).closeEvents(seasonId, now);
  };

  /** Aprova todos os pendentes pela aprovação de verdade e espera a liquidação de cada um. */
  async function approveAll(now: Date): Promise<number[]> {
    clock.set(now);
    const { results } = await service(ApproveService).approve(admin.id, { all: true });
    const ids = results.filter((r) => r.outcome === "approved").map((r) => r.eventId);
    for (const id of ids) await service(SettleCreditsService).settleEvent(id);
    return ids;
  }

  const plan = (seasonId: number, now: Date) => {
    clock.set(now);
    return service(CorrectionPlanService).plan(db(), seasonId, now);
  };

  /** `POST /admin/payouts/corrections`, com o token do admin no instante dado. */
  async function route(payload: unknown, now: Date, account: TestAccount = admin) {
    clock.set(now);
    const token = await account.tokenWith({ at: now });
    return app().inject({ method: "POST", url: "/admin/payouts/corrections", payload: payload as object, headers: { authorization: `Bearer ${token}` } });
  }

  const eventsOf = (seasonId: number, ticker: string) =>
    db().select().from(payoutEvents).where(and(eq(payoutEvents.seasonId, seasonId), eq(payoutEvents.clubId, club(ticker)))).orderBy(asc(payoutEvents.id));
  const currentOf = async (seasonId: number, ticker: string) => (await eventsOf(seasonId, ticker)).filter((e) => e.status !== "superseded");
  const creditsOf = (eventId: number) => db().select().from(payoutCredits).where(eq(payoutCredits.eventId, eventId)).orderBy(asc(payoutCredits.walletId));
  const holdingsOf = (eventId: number) =>
    db()
      .select({ walletId: payoutHoldings.walletId, shares: payoutHoldings.shares })
      .from(payoutHoldings)
      .where(eq(payoutHoldings.eventId, eventId))
      .orderBy(asc(payoutHoldings.walletId));
  const walletOf = async (walletId: number) => (await db().select().from(wallets).where(eq(wallets.id, walletId)))[0]!;
  const cashOf = async (walletId: number) => (await walletOf(walletId)).cash;
  const entriesOf = (walletId: number, kinds?: string[]) =>
    db()
      .select()
      .from(walletEntries)
      .where(eq(walletEntries.walletId, walletId))
      .orderBy(asc(walletEntries.id))
      .then((rows) => (kinds ? rows.filter((r) => kinds.includes(r.kind)) : rows));
  const orderOf = async (orderId: number) => (await db().select().from(orders).where(eq(orders.id, orderId)))[0]!;
  /** A soma dos créditos de todas as versões de uma chave, por carteira. */
  async function paidByKey(seasonId: number, ticker: string): Promise<Map<number, number>> {
    const { rows } = await db().execute(sql`
      select c.wallet_id, sum(c.amount)::bigint as paid
      from futbolsa.payout_credits c join futbolsa.payout_events e on e.id = c.event_id
      where e.season_id = ${seasonId} and e.club_id = ${club(ticker)}
      group by c.wallet_id order by c.wallet_id`);
    return new Map(rows.map((r) => [Number(r.wallet_id), Number(r.paid)]));
  }

  const domainError = async (promise: Promise<unknown>): Promise<DomainError> => {
    try {
      await promise;
    } catch (error) {
      if (error instanceof DomainError) return error;
      throw error;
    }
    throw new Error("era para recusar");
  };

  return {
    init,
    club,
    service,
    newSeason,
    player,
    bot,
    buy,
    transfer,
    setLastPrice,
    place,
    placeOk,
    game,
    round10,
    insertMatches,
    matchOf,
    setScore,
    close,
    approveAll,
    plan,
    route,
    eventsOf,
    currentOf,
    creditsOf,
    holdingsOf,
    walletOf,
    cashOf,
    entriesOf,
    orderOf,
    paidByKey,
    domainError,
    get admin() {
      return admin;
    },
  };
}
