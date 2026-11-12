import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { CLUBS } from "@futbolsa/engine/data/clubs";
import { FixedClock } from "../../../src/infra/clock/index.js";
import { withTransaction } from "../../../src/infra/db/index.js";
import { payoutCredits, payoutEvents, seasons } from "../../../src/infra/db/schema/index.js";
import { MemoryEventBus } from "../../../src/infra/realtime/memory-bus.js";
import { closeAtOfMonth, previousMonthKey } from "../../../src/modules/rankings/base.js";
import { CloseService } from "../../../src/modules/rankings/close.service.js";
import { equityAtWallets } from "../../../src/modules/rankings/equity-at.js";
import { LiveService } from "../../../src/modules/rankings/live.service.js";
import { RecalcService } from "../../../src/modules/rankings/recalc.service.js";
import { currentRowsOf, type StoredRow } from "../../../src/modules/rankings/snapshots.js";
import { useTestDatabase } from "../../support/db.js";
import { rng } from "../../support/fixtures.js";
import { applyMovements, insertPayout, portfolioSeason, setPrice, tradeBuy, tradeSell, type PortfolioSeason } from "../../portfolio/support.js";
import { BASE, bot, br, inTx, player, setBotsInRankings, setStatus } from "../support.js";
import { loadHistory, slowEquity, type History } from "./reference.js";

// T10 (revisão): propriedade com semente fixa. Carteiras, negócios, ajustes, estornos, pagamentos pendentes, aprovados
// com créditos em lotes, corrigidos (com estorno e complemento), atrasados e a recompra; instantes sorteados e as bordas
// (fechamento do mês exato, 1 ms depois, fechamento de evento, crédito). Três caminhos têm de dar o mesmo número: o
// `equityAtWallets` (o `EquityAt` da F10), a referência lenta que soma o extrato desde o começo e a parcial
// (`LiveService.current`). E o fechamento oficial e o recálculo têm de bater com a referência, base e posição inclusive.

const SEED = 20_261_112;
const PLAYERS = 120;
const TICKS = 520;
const START = br("2027-04-01 10:30").getTime();
const END = br("2027-11-20 18:00").getTime();
const X = br("2027-11-28 20:00").getTime(); // apito final: a recompra fecha (trading_ended_at)
const MONTHS = ["2027-04", "2027-05", "2027-06", "2027-07", "2027-08", "2027-09", "2027-10", "2027-11"];
const OFFICIAL = MONTHS.slice(0, 5); // abril a agosto oficiais; setembro em diante só pela parcial e pelo histórico

interface Ev {
  id: number;
  clubId: number;
  key: string;
  perShare: number;
  closedAt: number;
  holdings: Map<number, number>;
  status: "pending" | "approved";
  credited: Map<number, number>;
  scheduled: number;
  current: boolean;
  version: number;
}

/** Posições esperadas, escritas de novo: retorno exato por multiplicação cruzada, empate divide, sem base no fim. */
function expectedPositions(rows: ReadonlyArray<{ walletId: number; equity: number; base: number }>): Map<number, number> {
  const withBase = rows.filter((r) => r.base > 0);
  const cmp = (a: { equity: number; base: number }, b: { equity: number; base: number }) => {
    const left = BigInt(b.equity - b.base) * BigInt(a.base);
    const right = BigInt(a.equity - a.base) * BigInt(b.base);
    return left < right ? -1 : left > right ? 1 : 0;
  };
  const sorted = [...withBase].sort(cmp);
  const out = new Map<number, number>();
  let pos = 0;
  sorted.forEach((r, i) => {
    if (i === 0 || cmp(sorted[i - 1]!, r) !== 0) pos = i + 1;
    out.set(r.walletId, pos);
  });
  for (const r of rows) if (r.base <= 0) out.set(r.walletId, withBase.length + 1);
  return out;
}

describe("revisão T10: propriedade com semente fixa", () => {
  const database = useTestDatabase(6);
  const clock = new FixedClock(new Date(START));
  let s: PortfolioSeason;
  let tickers: string[];
  const all: number[] = [];
  const shown = new Set<number>(); // quem aparece nos rankings (ativos e bots com a chave ligada)
  const enteredAt = new Map<number, number>();
  const instants: number[] = [];
  let close: CloseService;
  let recalc: RecalcService;
  let live: LiveService;
  let h: History;
  let lastMayEvent: Ev | undefined;

  beforeAll(async () => {
    const db = database.db;
    const random = rng(SEED);
    s = await portfolioSeason(db);
    // 20 clubes listados, todos com preço de IPO de R$ 40,00
    expect(CLUBS.length).toBeGreaterThanOrEqual(20);
    await db.execute(sql`
      insert into futbolsa.season_clubs (season_id, club_id, division, total_shares, last_price, ipo_price)
      select ${s.seasonId}, c.id, 'A', 3000, 4000, 4000 from futbolsa.clubs c
      where c.id not in (select club_id from futbolsa.season_clubs where season_id = ${s.seasonId}) order by c.id limit 16`);
    const listed = await db.execute(sql`select c.id, c.ticker from futbolsa.season_clubs sc join futbolsa.clubs c on c.id = sc.club_id where sc.season_id = ${s.seasonId}`);
    for (const r of listed.rows) s.clubIds.set(String(r.ticker), Number(r.id));
    tickers = listed.rows.map((r) => String(r.ticker));
    expect(tickers).toHaveLength(20);
    await db.update(seasons).set({ ipoOpensAt: br("2027-04-01 10:00") }).where(eq(seasons.id, s.seasonId));
    await setBotsInRankings(db, s.seasonId, true);

    // carteiras: jogadores do início, quem entra no meio, bots, um bloqueado, uma conta excluída
    for (let i = 0; i < PLAYERS; i++) {
      const late = i % 15 === 7;
      const when = late ? new Date(START + Math.floor(random() * (END - START) * 0.7)) : undefined;
      const p = await player(db, s.seasonId, { enteredAt: when });
      all.push(p.wallet);
      enteredAt.set(p.wallet, when?.getTime() ?? br("2027-04-01 10:00").getTime());
      if (i === 3) await setStatus(db, p.account.id, "blocked");
      else if (i === 4) await setStatus(db, p.account.id, "deleted");
      else shown.add(p.wallet);
    }
    for (let i = 0; i < 6; i++) {
      const b = await bot(db, s.seasonId, i % 2 ? "dividendos" : "momentum");
      all.push(b.wallet);
      enteredAt.set(b.wallet, br("2027-04-01 10:00").getTime());
      shown.add(b.wallet);
    }
    // P8 garantido: alguém fecha maio com −R$ 250,00 (critério 13) e fica sem base em junho
    const broke = await player(db, s.seasonId);
    all.push(broke.wallet);
    enteredAt.set(broke.wallet, br("2027-04-01 10:00").getTime());
    shown.add(broke.wallet);
    for (const w of [s.buyer, s.seller]) {
      all.push(w);
      enteredAt.set(w, br("2027-04-01 10:00").getTime());
      shown.add(w);
    }

    // estado em memória, só para gerar movimentos válidos (o patrimônio vem do banco)
    const cash = new Map<number, number>(all.map((w) => [w, BASE]));
    const held = new Map<number, Map<number, number>>(all.map((w) => [w, new Map()]));
    const price = new Map<string, number>(tickers.map((t) => [t, 4000]));
    const events: Ev[] = [];
    let keyN = 0;

    type Act = { at: number; run: (at: number) => Promise<void> };
    const queue: Act[] = [];
    const push = (a: Act) => {
      let i = queue.length;
      while (i > 0 && queue[i - 1]!.at > a.at) i--;
      queue.splice(i, 0, a);
    };
    const active = (at: number) => all.filter((w) => enteredAt.get(w)! <= at && w !== s.buyer && w !== s.seller && w !== broke.wallet);
    await applyMovements(db, broke.wallet, br("2027-05-10 12:00"), { kind: "reversal", clubId: s.clubIds.get(tickers[0]!)!, cashDelta: -(BASE + 25_000), reason: "estorno" });
    instants.push(br("2027-05-10 12:00").getTime());
    const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;

    const credit = async (ev: Ev, eventId: number, walletId: number, at: number, amount: number) => {
      const kind = amount >= 0 ? (ev.credited.has(walletId) ? "complement" : "dividend") : "reversal";
      const { entry } = await applyMovements(db, walletId, new Date(at), {
        kind,
        clubId: ev.clubId,
        cashDelta: amount,
        reason: kind === "dividend" ? undefined : "correção do resultado",
        ref: { type: "payout", id: eventId },
      });
      await db.insert(payoutCredits).values({ eventId, walletId, amount, entryId: entry.id });
      cash.set(walletId, cash.get(walletId)! + amount);
      ev.credited.set(walletId, (ev.credited.get(walletId) ?? 0) + amount);
      ev.scheduled--;
      instants.push(at, at - 1);
    };
    /** Aprova e agenda os créditos em dois lotes (o segundo pode cair dias depois, até em outro mês). */
    const settle = (ev: Ev, from: number, amounts: Map<number, number>) => {
      const lot1 = from + 60_000 + Math.floor(random() * 3_600_000);
      const lot2 = lot1 + Math.floor(random() * 4 * 86_400_000);
      for (const [w, amount] of amounts) {
        if (amount === 0) continue;
        ev.scheduled++;
        const id = ev.id;
        push({ at: random() < 0.5 ? lot1 : lot2, run: (t) => credit(ev, id, w, t, amount) });
      }
    };

    const tick = async (at: number) => {
      const r = random();
      if (r < 0.55) {
        const ticker = pick(tickers);
        const clubId = s.clubIds.get(ticker)!;
        const p = Math.max(200, price.get(ticker)! + Math.round((random() - 0.5) * 800));
        price.set(ticker, p);
        await setPrice(db, s, ticker, new Date(at), p);
        const cands = active(at);
        if (cands.length === 0) return;
        const w = pick(cands);
        const mine = held.get(w)!.get(clubId) ?? 0;
        if (mine > 0 && random() < 0.45) {
          const q = 1 + Math.floor(random() * mine);
          await applyMovements(db, w, new Date(at), tradeSell(clubId, q, p));
          held.get(w)!.set(clubId, mine - q);
          cash.set(w, cash.get(w)! + q * p);
        } else if (cash.get(w)! >= p) {
          const q = 1 + Math.floor(random() * Math.min(300, Math.floor(cash.get(w)! / p)));
          if (q * p > cash.get(w)!) return;
          await applyMovements(db, w, new Date(at), tradeBuy(clubId, q, p));
          held.get(w)!.set(clubId, mine + q);
          cash.set(w, cash.get(w)! - q * p);
        }
      } else if (r < 0.61) {
        if (active(at).length === 0) return;
        const w = pick(active(at));
        if (random() < 0.5) {
          const amount = 1 + Math.floor(random() * 500_000);
          await applyMovements(db, w, new Date(at), { kind: "adjustment", cashDelta: amount, reason: "ajuste do admin" });
          cash.set(w, cash.get(w)! + amount);
        } else {
          const amount = -(1 + Math.floor(random() * (random() < 0.15 ? 12_000_000 : 300_000))); // às vezes deixa o caixa negativo
          await applyMovements(db, w, new Date(at), { kind: "reversal", clubId: s.clubIds.get(tickers[0]!)!, cashDelta: amount, reason: "estorno" });
          cash.set(w, cash.get(w)! + amount);
        }
      } else if (r < 0.8) {
        const clubId = s.clubIds.get(pick(tickers))!;
        const holders = new Map<number, number>();
        for (const w of all) if (enteredAt.get(w)! <= at && (held.get(w)!.get(clubId) ?? 0) > 0) holders.set(w, held.get(w)!.get(clubId)!);
        if (holders.size === 0) return;
        const perShare = 5 + Math.floor(random() * 150);
        const approved = random() < 0.6;
        const late = random() < 0.3;
        const key = `ev${++keyN}`;
        const id = await insertPayout(db, { seasonId: s.seasonId, clubId }, {
          key,
          perShare,
          closedAt: new Date(at),
          status: approved ? "approved" : "pending",
          holdings: [...holders],
          createdAt: new Date(late ? at + Math.floor(random() * 3 * 86_400_000) : at),
        });
        const ev: Ev = { id, clubId, key, perShare, closedAt: at, holdings: holders, status: approved ? "approved" : "pending", credited: new Map(), scheduled: 0, current: true, version: 1 };
        events.push(ev);
        if (at >= br("2027-05-01 00:00").getTime() && at < br("2027-05-31 00:00").getTime()) lastMayEvent = ev;
        instants.push(at, at - 1);
        if (approved) settle(ev, at, new Map([...holders].map(([w, n]) => [w, n * perShare])));
      } else if (r < 0.9) {
        // correção: só de evento sem crédito a caminho (a F12 aplica a correção depois de liquidar)
        const cands = events.filter((e) => e.current && e.scheduled === 0);
        if (cands.length === 0) return;
        const old = pick(cands);
        await db.update(payoutEvents).set({ status: "superseded" }).where(eq(payoutEvents.id, old.id));
        old.current = false;
        const holdings = new Map(old.holdings);
        if (holdings.size > 1 && random() < 0.3) holdings.delete([...holdings.keys()][0]!); // um sai da foto: estorno do total
        const perShare = 1 + Math.floor(random() * 200);
        const closedAt = random() < 0.15 ? Math.min(at, old.closedAt + Math.floor(random() * 6 * 3_600_000)) : old.closedAt;
        const status = old.status === "approved" || random() < 0.3 ? "approved" : "pending";
        const id = await insertPayout(db, { seasonId: s.seasonId, clubId: old.clubId }, {
          key: old.key,
          perShare,
          closedAt: new Date(closedAt),
          status,
          version: old.version + 1,
          holdings: [...holdings],
          createdAt: new Date(at),
        });
        const ev: Ev = { id, clubId: old.clubId, key: old.key, perShare, closedAt, holdings, status, credited: new Map(old.credited), scheduled: 0, current: true, version: old.version + 1 };
        events.push(ev);
        instants.push(closedAt, closedAt - 1);
        if (status === "approved") {
          const diffs = new Map<number, number>();
          for (const w of new Set([...holdings.keys(), ...old.credited.keys()])) diffs.set(w, (holdings.get(w) ?? 0) * perShare - (old.credited.get(w) ?? 0));
          settle(ev, at, diffs);
        }
      } else {
        const cands = events.filter((e) => e.current && e.status === "pending");
        if (cands.length === 0) return;
        const ev = pick(cands);
        await db.update(payoutEvents).set({ status: "approved", approvedAt: new Date(at) }).where(eq(payoutEvents.id, ev.id));
        ev.status = "approved";
        settle(ev, at, new Map([...ev.holdings].map(([w, n]) => [w, n * ev.perShare - (ev.credited.get(w) ?? 0)])));
      }
    };

    for (let i = 0; i < TICKS; i++) push({ at: START + Math.floor(random() * (END - START) / 1000) * 1000, run: tick });
    // as bordas do fechamento: um negócio exatamente às 23:59:00,000 e outro 1 ms depois, em todo mês
    for (const m of MONTHS.slice(0, -1)) {
      const c = closeAtOfMonth(m).getTime();
      push({ at: c, run: tick });
      push({ at: c + 1, run: tick });
      instants.push(c, c + 1, c - 1);
    }
    while (queue.length > 0) {
      const a = queue.shift()!;
      await a.run(a.at);
    }

    // a recompra fecha em X: um evento `buyback` por clube; metade aprovada e liquidada em lotes (tira as ações)
    await db.update(seasons).set({ tradingEndedAt: new Date(X) }).where(eq(seasons.id, s.seasonId));
    for (const ticker of tickers) {
      const clubId = s.clubIds.get(ticker)!;
      const holders = [...all].filter((w) => (held.get(w)!.get(clubId) ?? 0) > 0).map((w) => [w, held.get(w)!.get(clubId)!] as [number, number]);
      if (holders.length === 0) continue;
      const v = Math.round(price.get(ticker)! * 1.5);
      const approved = random() < 0.5;
      const id = await insertPayout(db, { seasonId: s.seasonId, clubId }, { key: `buyback|${ticker}`, kind: "buyback", perShare: v, closedAt: new Date(X), status: approved ? "approved" : "pending", holdings: holders });
      if (!approved) continue;
      for (const [w, n] of holders) {
        const when = X + (random() < 0.5 ? 3_600_000 : 2 * 86_400_000);
        const { entry } = await applyMovements(db, w, new Date(when), { kind: "buyback", clubId, cashDelta: n * v, sharesDelta: -n, price: v, costBasis: "sale", ref: { type: "payout", id } });
        await db.insert(payoutCredits).values({ eventId: id, walletId: w, amount: n * v, entryId: entry.id });
        instants.push(when, when - 1);
      }
    }
    instants.push(X - 1, X, X + 1, X + 3 * 86_400_000);
    for (let i = 0; i < 10; i++) instants.push(START + Math.floor(random() * (X - START)));

    close = new CloseService(db, clock);
    recalc = new RecalcService(db, clock);
    live = new LiveService(db, clock, new MemoryEventBus(clock));
    for (const m of OFFICIAL) await inTx(db, (tx) => close.closeMonth(tx, { seasonId: s.seasonId, monthKey: m, at: closeAtOfMonth(m) }));
    h = await loadHistory(db, s.seasonId);
  }, 600_000);

  it("o EquityAt (equityAtWallets) é igual à referência lenta em todos os instantes sorteados e nas bordas", async () => {
    // as bordas do mês e da recompra sempre; dos instantes de eventos e créditos (e 1 ms antes), uma amostra fixa
    const pool = [...new Set(instants)].sort((a, b) => a - b);
    const pickRandom = rng(SEED + 1);
    const sample = new Set<number>(MONTHS.flatMap((m) => [closeAtOfMonth(m).getTime(), closeAtOfMonth(m).getTime() + 1, closeAtOfMonth(m).getTime() - 1]));
    for (const t of [X - 1, X, X + 1]) sample.add(t);
    while (sample.size < 240 && sample.size < pool.length) sample.add(pool[Math.floor(pickRandom() * pool.length)]!);
    const probes = [...sample].sort((a, b) => a - b);
    expect(pool.length).toBeGreaterThan(240);
    let compared = 0;
    for (const t of probes) {
      const fast = await withTransaction(database.db, (tx) => equityAtWallets(tx, s.seasonId, new Date(t), all), { isolationLevel: "repeatable read", readOnly: true });
      for (const w of all) {
        const slow = slowEquity(h, w, t);
        const mine = fast.get(w);
        if (!slow) {
          expect(mine, `carteira ${w} não existia em ${new Date(t).toISOString()}`).toBeUndefined();
          continue;
        }
        expect(mine, `carteira ${w} em ${new Date(t).toISOString()}`).toBeDefined();
        expect({ w, t: new Date(t).toISOString(), cash: mine!.cash, receivable: mine!.receivable, equity: mine!.equity }).toEqual({
          w,
          t: new Date(t).toISOString(),
          cash: slow.cash,
          receivable: slow.receivable,
          equity: slow.equity,
        });
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(20_000);
    // o sorteio cobriu o que a revisão pede: corrigidos, pendentes, atrasados, estornos e muitos negócios
    const [stats] = (
      await database.db.execute(sql`select
        (select count(*)::int from futbolsa.payout_events where season_id = ${s.seasonId} and status = 'superseded') as superseded,
        (select count(*)::int from futbolsa.payout_events where season_id = ${s.seasonId} and status = 'pending') as pending,
        (select count(*)::int from futbolsa.payout_events where season_id = ${s.seasonId} and created_at > closed_at) as late,
        (select count(*)::int from futbolsa.payout_credits c join futbolsa.payout_events e on e.id = c.event_id where e.season_id = ${s.seasonId} and c.amount < 0) as reversals,
        (select count(*)::int from futbolsa.trades where season_id = ${s.seasonId}) as trades`)
    ).rows as Array<Record<string, number>>;
    expect(stats).toMatchObject({ superseded: expect.any(Number) });
    for (const k of ["superseded", "pending", "late", "reversals"]) expect(stats![k], k).toBeGreaterThan(2);
    expect(stats!.trades).toBeGreaterThan(250);
  }, 600_000);

  const expectedBase = async (month: string, walletId: number): Promise<number> => {
    const prev = previousMonthKey(month);
    const prevClose = closeAtOfMonth(prev).getTime();
    if (enteredAt.get(walletId)! > prevClose) return BASE;
    const official = await inTx(database.db, (tx) => currentRowsOf(tx, s.seasonId, "month", prev));
    const row = official?.get(walletId);
    return row ? row.equity : slowEquity(h, walletId, prevClose)!.equity;
  };

  const checkOfficial = async (month: string, rows: Map<number, StoredRow>) => {
    const c = closeAtOfMonth(month).getTime();
    const expectedSet = [...shown].filter((w) => enteredAt.get(w)! <= c).sort((a, b) => a - b);
    expect([...rows.keys()].sort((a, b) => a - b)).toEqual(expectedSet);
    const want: Array<{ walletId: number; equity: number; base: number }> = [];
    for (const w of expectedSet) want.push({ walletId: w, equity: slowEquity(h, w, c)!.equity, base: await expectedBase(month, w) });
    const positions = expectedPositions(want);
    for (const r of want) expect({ month, ...rows.get(r.walletId)! }).toEqual({ month, walletId: r.walletId, equity: r.equity, base: r.base, position: positions.get(r.walletId)! });
  };

  it("cada mês oficial (abril a agosto): conjunto, patrimônio, base (P2: oficial anterior ou histórico) e posição iguais aos da referência", async () => {
    for (const m of OFFICIAL) await checkOfficial(m, (await inTx(database.db, (tx) => currentRowsOf(tx, s.seasonId, "month", m)))!);
    // P8: o sorteio tem de ter produzido gente sem base em algum mês
    const noBase = await database.db.execute(sql`select count(*)::int as n from futbolsa.ranking_rows r join futbolsa.ranking_snapshots s on s.id = r.snapshot_id where s.season_id = ${s.seasonId} and r.base <= 0`);
    expect(Number(noBase.rows[0]!.n)).toBeGreaterThan(0);
  }, 300_000);

  it("a parcial (LiveService.current) dá o mesmo patrimônio, a mesma base e a mesma posição que a referência, no mês e na temporada", async () => {
    const lives = [br("2027-06-15 14:00"), br("2027-08-31 23:59:30"), br("2027-09-20 11:11:11"), br("2027-10-01 00:00:10"), new Date(X + 86_400_000)];
    for (const now of lives) {
      clock.set(now);
      const t = now.getTime();
      for (const period of ["month", "season"] as const) {
        const snap = (await live.current(period, { force: true }))!;
        const expectedSet = [...shown].filter((w) => enteredAt.get(w)! <= t).sort((a, b) => a - b);
        expect(snap.rows.map((r) => r.walletId).sort((a, b) => a - b)).toEqual(expectedSet);
        const want: Array<{ walletId: number; equity: number; base: number }> = [];
        for (const w of expectedSet) want.push({ walletId: w, equity: slowEquity(h, w, t)!.equity, base: period === "season" ? BASE : await expectedBase(snap.periodKey, w) });
        const positions = expectedPositions(want);
        for (const r of want) {
          const got = snap.byWallet.get(r.walletId)!;
          expect({ period, at: now.toISOString(), walletId: got.walletId, equity: got.equity, base: got.base, position: got.position }).toEqual({
            period,
            at: now.toISOString(),
            walletId: r.walletId,
            equity: r.equity,
            base: r.base,
            position: positions.get(r.walletId)!,
          });
        }
      }
    }
  }, 300_000);

  it("recálculo sem mudança não grava versão; depois de uma correção de maio, só os meses mudados ganham versão e tudo volta a bater com a referência", async () => {
    const db = database.db;
    clock.set(new Date(X + 5 * 86_400_000));
    await inTx(db, (tx) => recalc.requestRecalc(tx, { seasonId: s.seasonId, from: br("2027-04-01 00:00"), reason: "conferência" }));
    expect(await recalc.processRecalcRequests(clock.now())).toEqual([{ seasonId: s.seasonId, versions: [] }]);

    // corrige um evento de maio: abril não muda; maio a agosto mudam (patrimônio ou base, pela cascata)
    const ev = lastMayEvent!;
    expect(ev).toBeDefined();
    const [cur] = await db.execute(sql`select id, version, per_share, status from futbolsa.payout_events where season_id = ${s.seasonId} and club_id = ${ev.clubId} and event_key = ${ev.key} and status <> 'superseded'`).then((r) => r.rows);
    await db.update(payoutEvents).set({ status: "superseded" }).where(eq(payoutEvents.id, Number(cur!.id)));
    const holdings = (await db.execute(sql`select wallet_id, shares from futbolsa.payout_holdings where event_id = ${Number(cur!.id)}`)).rows.map((r) => [Number(r.wallet_id), Number(r.shares) * 3] as [number, number]);
    await insertPayout(db, { seasonId: s.seasonId, clubId: ev.clubId }, { key: ev.key, perShare: Number(cur!.per_share) + 777, closedAt: new Date(ev.closedAt), status: "pending", version: Number(cur!.version) + 1, holdings, createdAt: clock.now() });
    await inTx(db, (tx) => recalc.requestRecalc(tx, { seasonId: s.seasonId, from: new Date(ev.closedAt), reason: "correção" }));
    const done = await recalc.processRecalcRequests(clock.now());
    expect(done[0]!.versions).toEqual(["month:2027-05", "month:2027-06", "month:2027-07", "month:2027-08"]);
    const versions = await db.execute(sql`select period_key, max(version)::int as v from futbolsa.ranking_snapshots where season_id = ${s.seasonId} group by period_key order by period_key`);
    expect(versions.rows.map((r) => `${r.period_key}:${r.v}`)).toEqual(["2027-04:1", "2027-05:2", "2027-06:2", "2027-07:2", "2027-08:2"]);
    h = await loadHistory(db, s.seasonId);
    for (const m of OFFICIAL) await checkOfficial(m, (await inTx(db, (tx) => currentRowsOf(tx, s.seasonId, "month", m)))!);
    // e a versão 1 de cada um continua lá
    const v1 = await db.execute(sql`select count(*)::int as n from futbolsa.ranking_snapshots where season_id = ${s.seasonId} and version = 1`);
    expect(Number(v1.rows[0]!.n)).toBe(OFFICIAL.length);
  }, 300_000);
});
