import "reflect-metadata";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { AUCTION_DURATION_MS, TUNNEL_BP, type Cents } from "@futbolsa/engine";
import { FixedClock } from "../../src/infra/clock/index.js";
import type { Database } from "../../src/infra/db/client.js";
import { orders } from "../../src/infra/db/schema/index.js";
import type { AdminEvents } from "../../src/modules/admin/events.js";
import { AdminLogService } from "../../src/modules/admin/log/index.js";
import { SuspensionService } from "../../src/modules/admin/suspension/suspension.service.js";
import {
  AuctionCloser,
  CancelService,
  CloseAuctionService,
  MarketPortImpl,
  OrderService,
  PostgresMatchingEngine,
  RefreshService,
  type CloseAuctionResult,
  type PlaceOrderInput,
} from "../../src/modules/market/index.js";
import { PortfolioLedger } from "../../src/modules/portfolio/index.js";
import { useTestDatabase } from "../support/db.js";
import { createUser, openPlayerWallets, rng } from "../support/fixtures.js";
import { totalCash } from "../support/invariants.js";
import { marketSeason } from "./helpers.js";
import { accepted, assertMarketInvariants, clubRow, giveShares, openBot, openTreasury, orderInputs, setTunnelState, syncTotalShares } from "./order-helpers.js";

// T16 do Plano do livro de ofertas e formador: concorrência em volume. Um sorteio com semente fixa de ordens
// (limitadas e a mercado, compras e vendas, algumas fora do túnel, que abrem leilão), cancelamentos, reposições da
// casa, fins de leilão e duas suspensões (a do FLA3 no meio de um leilão, com retomada; a do mercado todo, mais
// tarde), em 3 clubes ao mesmo tempo, com 20 jogadores, 2 bots e a tesouraria. Cada rajada roda dezenas de operações
// juntas (`Promise.all`) num pool de 30 conexões. No fim: extrato igual às carteiras, ações e caixa conservados,
// contador de ordens abertas e reservas iguais ao livro, nenhum livro cruzado e nenhuma repetição por *deadlock*.

const TICKERS = ["FLA3", "PAL3", "SPT3"] as const;
const SEED = 20261111;
const RICH = 5_000_000;
/** Ações de cada jogador e bot em cada clube; a tesouraria tem mais, para cotar a venda. */
const SHARES = 300;
const HOUSE_SHARES = 2_000;
const OPS_PER_BURST = 30;
const BURST_MS = 20_000;

/** Um instante pelo relógio de Brasília, no mesmo dia (a referência do túnel não vira no meio do teste). */
const brt = (time: string) => new Date(`2027-04-06T${time}:00-03:00`);
const later = (at: Date, ms: number) => new Date(at.getTime() + ms);
const quietAdminEvents = { marketSuspended() {}, marketResumed() {} } as unknown as AdminEvents;
const noFairValue = { compute: async (): Promise<Map<string, Cents>> => new Map() };

/** As três fases: cada uma começa depois de todo leilão aberto na anterior ter vencido (3 horas, já com a pausa). */
const PHASES = [
  { start: brt("10:00"), bursts: 30 },
  { start: brt("13:30"), bursts: 30 },
  { start: brt("17:30"), bursts: 20 },
] as const;
const CLUB_SUSPEND = 10;
const CLUB_RESUME = 18;
const MARKET_SUSPEND = 40;
const MARKET_RESUME = 46;

describe("o mercado em volume, com tudo ao mesmo tempo, contra o Postgres", () => {
  const t = useTestDatabase(30);
  let db: Database;
  let seasonId: number;
  let clubIds: Map<string, number>;
  const clock = new FixedClock(PHASES[0].start);
  let service: OrderService;
  let cancels: CancelService;
  let refresher: RefreshService;
  let closer: CloseAuctionService;
  let suspension: SuspensionService;
  let admin: string;
  let treasury: number;
  let traders: { walletId: number; actor: "player" | "bot" }[];
  let forcer: { buyer: number; seller: number };
  let cashBefore: number;
  const o = orderInputs({ seasonId: 0, now: PHASES[0].start });

  /** Repetições do `withTransaction` por *deadlock* (ou conflito de serialização): o esperado é zero. */
  const retries: string[] = [];
  const transaction = { onRetry: (attempt: number, code: string) => retries.push(`${code} (repetição ${attempt})`) };
  /** O que o sorteio fez, por tipo de resultado: o relatório da T16 cita estas contagens. */
  const counts = new Map<string, number>();
  const count = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);
  const closedResult = (prefix: string, r: CloseAuctionResult) => count(r.closed ? `${prefix}: fechou` : `${prefix}: ${r.reason}`);

  beforeAll(async () => {
    db = t.db;
    ({ seasonId, clubIds } = await marketSeason(db, { tickers: TICKERS }));
    const ledger = new PortfolioLedger();
    closer = new CloseAuctionService(db, ledger);
    // quem chega depois do fim do leilão (ordem, cancelamento, reposição) fecha por aqui, com o contador de repetições
    const counted = new (class extends AuctionCloser {
      async closeAuction(season: number, ticker: string, now: Date): Promise<void> {
        closedResult("fim do leilão por quem chegou depois", await closer.closeAuction(season, ticker, now, { transaction }));
      }
    })();
    service = new OrderService(db, new PostgresMatchingEngine(ledger), counted);
    cancels = new CancelService(db, ledger, counted);
    refresher = new RefreshService(db, service, cancels, noFairValue, clock, counted);
    suspension = new SuspensionService(db, new AdminLogService(clock, db), new MarketPortImpl(cancels, refresher, clock), quietAdminEvents);
    admin = await createUser(db);

    treasury = await openTreasury(db, seasonId, 50_000_000);
    const players = await openPlayerWallets(db, seasonId, 20, RICH);
    const bots = [await openBot(db, seasonId, RICH), await openBot(db, seasonId, RICH)];
    traders = [...players.map((walletId) => ({ walletId, actor: "player" as const })), ...bots.map((walletId) => ({ walletId, actor: "bot" as const }))];
    // a dupla que abre o leilão de propósito antes da suspensão do clube (fora do sorteio)
    const [buyer, seller] = (await openPlayerWallets(db, seasonId, 2, 50_000_000)) as [number, number];
    forcer = { buyer, seller };
    for (const ticker of TICKERS) {
      await giveShares(db, treasury, club(ticker), HOUSE_SHARES);
      for (const w of [...players, ...bots]) await giveShares(db, w, club(ticker), SHARES);
      await giveShares(db, seller, club(ticker), 50);
      await setTunnelState(db, seasonId, club(ticker), { lastPrice: 4000, tunnelRef: 4000, tunnelRefDay: brt("00:00") });
    }
    await syncTotalShares(db, seasonId);
    cashBefore = await totalCash(db, seasonId);
  });

  const club = (ticker: string) => clubIds.get(ticker)!;
  const row = (ticker: string) => clubRow(db, seasonId, club(ticker));

  /** Preço em múltiplos de 10 centavos, nunca abaixo de R$ 1,00. */
  const price = (value: number) => Math.max(100, Math.round(value / 10) * 10);

  /**
   * Abre um leilão no clube de propósito (o sorteio sozinho pode não ter aberto um a tempo da suspensão): uma venda
   * pouco acima do túnel e uma compra que leva tudo o que está à venda até ela, como no critério 39.
   */
  async function forceAuction(ticker: string, now: Date): Promise<void> {
    const before = await row(ticker);
    if (before.auctionOpenedAt !== null) return;
    const ref = before.tunnelRef ?? before.lastPrice;
    const ask = price((ref * (10_000 + TUNNEL_BP + 125)) / 10_000);
    accepted(await service.place({ ...o.sellLimit(forcer.seller, ticker, 5, ask), seasonId, now }, { transaction }));
    const [{ n }] = (
      await db.execute(
        sql`select coalesce(sum(${orders.quantity} - ${orders.filled}), 0)::int as n from ${orders}
            where ${orders.clubId} = ${club(ticker)} and ${orders.status} = 'open' and ${orders.side} = 'sell' and ${orders.limitPrice} <= ${ask}`,
      )
    ).rows as [{ n: number }];
    const buy = accepted(await service.place({ ...o.buyLimit(forcer.buyer, ticker, Number(n), price(ask + 50)), seasonId, now }, { transaction }));
    expect(buy.openedAuction || (await row(ticker)).auctionOpenedAt !== null).toBe(true);
    count("leilão aberto de propósito");
  }

  /** As ordens abertas dos jogadores e bots (a casa só cancela pela reposição), para o sorteio cancelar. */
  async function cancellable(): Promise<{ id: number; walletId: number }[]> {
    return db
      .select({ id: orders.id, walletId: orders.walletId })
      .from(orders)
      .where(and(eq(orders.seasonId, seasonId), eq(orders.status, "open"), ne(orders.walletId, treasury), inArray(orders.walletId, traders.map((x) => x.walletId))));
  }

  /** Uma rajada: `OPS_PER_BURST` operações sorteadas, mais as extras, todas ao mesmo tempo no mesmo instante. */
  async function burst(random: () => number, now: Date, extra: (() => Promise<void>)[] = []): Promise<void> {
    clock.set(now);
    const prices = new Map<string, number>();
    for (const ticker of TICKERS) prices.set(ticker, (await row(ticker)).lastPrice);
    const open = await cancellable();
    const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;

    const ops: (() => Promise<void>)[] = [];
    for (let i = 0; i < OPS_PER_BURST; i++) {
      const ticker = pick(TICKERS);
      const ref = prices.get(ticker)!;
      const who = pick(traders);
      const roll = random();
      const side = random() < 0.5 ? "buy" : "sell";
      const extraInput: Partial<PlaceOrderInput> = { seasonId, now, actor: who.actor };
      if (roll < 0.5) {
        // limitada perto do preço (até 12% para cada lado: algumas ficam fora do túnel, no livro)
        const limit = price(ref * (1 + (random() * 2 - 1) * 0.12));
        const quantity = 1 + Math.floor(random() * 20);
        const input = side === "buy" ? o.buyLimit(who.walletId, ticker, quantity, limit, extraInput) : o.sellLimit(who.walletId, ticker, quantity, limit, extraInput);
        ops.push(() => placeCounted(input, `limitada ${side}`));
      } else if (roll < 0.62) {
        const quantity = 1 + Math.floor(random() * 10);
        const input = side === "buy" ? o.buyMarket(who.walletId, ticker, quantity, undefined, extraInput) : o.sellMarket(who.walletId, ticker, quantity, undefined, extraInput);
        ops.push(() => placeCounted(input, `a mercado ${side}`));
      } else if (roll < 0.66) {
        // a que sai do túnel: varre o livro até 20% do preço e abre o leilão se houver oferta além do túnel
        const quantity = 30 + Math.floor(random() * 50);
        const input =
          side === "buy" ? o.buyLimit(who.walletId, ticker, quantity, price(ref * 1.2), extraInput) : o.sellLimit(who.walletId, ticker, quantity, price(ref * 0.8), extraInput);
        ops.push(() => placeCounted(input, `fora do túnel ${side}`));
      } else if (roll < 0.86) {
        if (open.length === 0) continue;
        const target = pick(open);
        ops.push(async () => {
          const r = await cancels.cancelOrder({ walletId: target.walletId, orderId: target.id, now }, { transaction });
          count(r.ok ? "cancelamento: cancelou" : `cancelamento: ${r.code}`);
        });
      } else if (roll < 0.96) {
        const fair = price(4000 * (1 + (random() * 2 - 1) * 0.05));
        ops.push(async () => {
          const r = await refresher.refreshClub(seasonId, ticker, now, { fairValues: new Map([[ticker, fair]]), inMatch: false, transaction });
          count(r.refreshed ? "reposição: cotou" : `reposição: ${r.reason}`);
        });
      } else {
        ops.push(async () => closedResult("fim do leilão sorteado", await closer.closeAuction(seasonId, ticker, now, { transaction })));
      }
    }
    await Promise.all([...ops, ...extra].map((op) => op()));
  }

  async function placeCounted(input: PlaceOrderInput, kind: string): Promise<void> {
    const r = await service.place(input, { transaction });
    if (r.ok) {
      count(`${kind}: aceita`);
      if (r.openedAuction) count("leilão aberto pelo sorteio");
    } else count(`${kind}: ${"auctionExpired" in r ? "leilão vencido" : r.code}`);
  }

  const closeAll = (now: Date) => TICKERS.map((ticker) => async () => closedResult("fim do leilão na virada da fase", await closer.closeAuction(seasonId, ticker, now, { transaction })));

  it(
    "T16: ordens, cancelamentos, reposições, leilões e suspensões sorteados em 3 clubes, em rajadas concorrentes, conservam tudo",
    async () => {
      const random = rng(SEED);
      const startedAt = Date.now();
      let index = 0;
      let suspendedAuctionUntil: Date | null = null;
      for (const [p, phase] of PHASES.entries()) {
        for (let b = 0; b < phase.bursts; b++, index++) {
          const now = later(phase.start, b * BURST_MS);
          const extra: (() => Promise<void>)[] = [];
          // a virada da fase: os leilões da fase anterior venceram e fecham junto com as ordens que chegam
          if (b === 0 && p > 0) extra.push(...closeAll(now));
          if (index === CLUB_SUSPEND) {
            await forceAuction("FLA3", now);
            extra.push(async () => void (await suspension.suspend(admin, { ticker: "FLA3", reason: "estádio interditado" })));
          }
          if (index === CLUB_RESUME) extra.push(async () => void (await suspension.resume(admin, "FLA3")));
          if (index === MARKET_SUSPEND) extra.push(async () => void (await suspension.suspend(admin, { reason: "falha na fonte dos placares" })));
          if (index === MARKET_RESUME) extra.push(async () => void (await suspension.resume(admin, undefined)));
          await burst(random, now, extra);

          if (index === CLUB_SUSPEND) {
            // parado no meio do leilão: fica só o início dele, e nada fecha
            expect(await row("FLA3")).toMatchObject({ auctionUntil: null });
            expect((await row("FLA3")).auctionOpenedAt).not.toBeNull();
            count("suspensão do clube no meio do leilão");
          }
          if (index === CLUB_RESUME) {
            suspendedAuctionUntil = (await row("FLA3")).auctionUntil;
            expect(suspendedAuctionUntil).toEqual(later(now, AUCTION_DURATION_MS));
            count("retomada do clube com o leilão recomeçado");
          }
          if (index === MARKET_SUSPEND) count("suspensão do mercado");
          if (index === MARKET_RESUME) count("retomada do mercado");
        }
        // entre as fases, tudo conferido (o livro dos clubes em leilão pode estar cruzado: a invariante os ignora)
        await assertMarketInvariants(db, seasonId, cashBefore);
      }
      // o fim: todo leilão aberto na última fase vence e fecha; aí nenhum livro pode estar cruzado
      const end = brt("21:30");
      await Promise.all(closeAll(end).map((op) => op()));
      for (const ticker of TICKERS) expect(await row(ticker)).toMatchObject({ auctionOpenedAt: null, auctionUntil: null });
      await assertMarketInvariants(db, seasonId, cashBefore);

      const report = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `  ${k}: ${v}`);
      const [{ trades: tradeCount, auction }] = (
        await db.execute(sql`select count(*)::int as trades, count(*) filter (where in_auction)::int as auction from futbolsa.trades where season_id = ${seasonId}`)
      ).rows as [{ trades: number; auction: number }];
      console.info(
        [`T16: ${index} rajadas em ${((Date.now() - startedAt) / 1000).toFixed(1)} s; negócios ${tradeCount} (${auction} em leilão)`, ...report, `  repetições: ${retries.length}`].join("\n"),
      );
      // o sorteio cobriu o que a T16 pede
      const sum = (prefix: string) => [...counts].filter(([k]) => k.startsWith(prefix)).reduce((s, [k, v]) => s + (k.endsWith(": aceita") ? v : 0), 0);
      expect(sum("limitada")).toBeGreaterThan(200);
      expect(sum("a mercado")).toBeGreaterThan(20);
      expect(counts.get("cancelamento: cancelou") ?? 0).toBeGreaterThan(50);
      expect(counts.get("reposição: cotou") ?? 0).toBeGreaterThan(50);
      expect((counts.get("leilão aberto pelo sorteio") ?? 0) + (counts.get("leilão aberto de propósito") ?? 0)).toBeGreaterThanOrEqual(2);
      expect(auction).toBeGreaterThan(0);
      expect(counts.get("suspensão do clube no meio do leilão")).toBe(1);
      expect(retries).toEqual([]);
    },
    180_000,
  );
});
