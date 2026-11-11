// Medição do tempo das travas do mercado (Plano do livro de ofertas e formador, T16; Arquitetura da Fase 1, "Escala").
// Não é teste automático: o tempo depende da máquina. Mede duas coisas, num banco próprio criado e apagado aqui:
//
// 1. Carga: 100 ordens por segundo durante alguns segundos, metade num clube só (FLA3) e o resto em outros 3, com a
//    casa cotando nos 4. Por clube: a espera pela trava do clube e o tempo com ela (da trava ao COMMIT), p50 e p95.
//    Também a espera pelas carteiras (a tesouraria é a última e a mais disputada) nas ordens que negociaram com a casa.
// 2. Fim de um leilão com 2.000 ordens no livro (1.000 de cada lado, cruzadas, com a casa entre elas): o tempo total
//    e o tempo com as carteiras travadas, a tesouraria junto (da trava das carteiras ao COMMIT).
//
//   TEST_DATABASE_URL=... node --import tsx apps/api/scripts/market-lock-timing.mjs [segundos=5] [ordens/s=100]
//
// (o servidor de TEST_DATABASE_URL só ganha um banco `futbolsa_timing_*`, apagado no fim; a URL nunca é impressa)
//
// Resultado em 2026-11-11 (notebook de 8 GB, Postgres 17 nativo, pool de 20 conexões, 5 s a 100 ordens/s):
//   carga: 500 ordens pedidas a 100/s levaram 9,8 s (51/s): o FLA3 sozinho não dá conta de 50 ordens/s.
//     FLA3 (metade): espera pela trava do clube p50 567 ms, p95 768 ms; com a trava p50 27 ms, p95 81 ms
//     PAL3, SPT3, COR3: espera p50 2 ms, p95 35 a 346 ms; com a trava p50 30 a 32 ms, p95 89 a 100 ms
//     espera pelas carteiras com a casa (tesouraria) no negócio: p50 3,2 ms, p95 28 ms; sem a casa: p50 2,4 ms, p95 6 ms
//     => com ~27 ms de trava por ordem, um clube aguenta ~35 ordens/s; acima disso a fila cresce na trava do clube.
//   fim do leilão: 2.048 ordens no livro, 1.642 negócios, 98 carteiras (a tesouraria entre elas)
//     total 27,2 s; leitura do livro e preço único 24 ms; carteiras e tesouraria travadas até o COMMIT 27,2 s,
//     dos quais extrato (portfolio.post, 2 por negócio) 16,9 s, candles (recordTrade, 1 por negócio) 3,5 s e o resto
//     (linha do negócio, ordens, trava das carteiras, COMMIT) 6,8 s. Pesa: ~16,6 ms por negócio, quase tudo em
//     comandos um a um; a saída do plano é o `portfolio.postMany` da F11 (o extrato em lote) e os candles somados
//     uma vez por leilão em vez de um `recordTrade` por negócio.
import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import pg from "pg";

const seconds = Number(process.argv[2] ?? 5);
const rate = Number(process.argv[3] ?? 100);
const AUCTION_ORDERS = 2_000;

const { connect } = await import("../src/infra/db/client.ts");
const { runMigrations } = await import("../src/infra/db/migrate.ts");
const { lockClubs, lockWallets, withTransaction } = await import("../src/infra/db/index.ts");
const { FixedClock } = await import("../src/infra/clock/index.ts");
const { seasonClubs } = await import("../src/infra/db/schema/index.ts");
const { post } = await import("../src/modules/portfolio/ledger/index.ts");
const { PortfolioLedger } = await import("../src/modules/portfolio/index.ts");
const market = await import("../src/modules/market/index.ts");
const { marketSeason } = await import("../test/market/helpers.ts");
const { openPlayerWallets, openWallets, T0 } = await import("../test/support/fixtures.ts");
const { and, eq } = await import("drizzle-orm");

const baseUrl = process.env.TEST_DATABASE_URL;
if (!baseUrl) throw new Error("defina TEST_DATABASE_URL (o Postgres dos testes)");
const withDatabase = (database) => {
  const u = new URL(baseUrl);
  u.pathname = `/${database}`;
  return u.toString();
};
async function admin(sql) {
  const client = new pg.Client({ connectionString: baseUrl });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

const pct = (values, p) => {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const fmt = (values) => `p50 ${pct(values, 50).toFixed(1)} ms, p95 ${pct(values, 95).toFixed(1)} ms (n=${values.length})`;

const name = `futbolsa_timing_${process.pid}_${randomBytes(3).toString("hex")}`;
await admin(`create database "${name}"`);
const url = withDatabase(name);
let conn;
try {
  await runMigrations(url);
  conn = connect(url, 20);
  const db = conn.db;
  const TICKERS = ["FLA3", "PAL3", "SPT3", "COR3"];
  const { seasonId, clubIds } = await marketSeason(db, { tickers: TICKERS });
  const club = (t) => clubIds.get(t);
  const start = new Date("2027-04-06T10:00:00-03:00");
  const clock = new FixedClock(start);
  const ledger = new PortfolioLedger();
  const closer = new market.CloseAuctionService(db, ledger);
  const adapter = new market.CloseAuctionAdapter(closer);
  const service = new market.OrderService(db, new market.PostgresMatchingEngine(ledger), adapter);
  const cancels = new market.CancelService(db, ledger, adapter);
  const refresher = new market.RefreshService(db, service, cancels, { compute: async () => new Map() }, clock, adapter);

  const give = (walletId, delta) =>
    withTransaction(db, async (tx) => {
      await lockWallets(tx, [walletId]);
      await post(tx, { walletId, at: T0, ...delta });
    });
  const [treasury] = await openWallets(db, seasonId, [{ type: "treasury" }]);
  await give(treasury, { kind: "adjustment", cashDelta: 500_000_000, reason: "caixa da medição" });
  const players = await openPlayerWallets(db, seasonId, 60, 50_000_000);
  for (const t of TICKERS) {
    await give(treasury, { kind: "ipo_settle", clubId: club(t), sharesDelta: 20_000, price: 4000, costBasis: "purchase" });
    for (const w of players) await give(w, { kind: "ipo_settle", clubId: club(t), sharesDelta: 2_000, price: 4000, costBasis: "purchase" });
    await db
      .update(seasonClubs)
      .set({ lastPrice: 4000, tunnelRef: 4000, tunnelRefDay: new Date("2027-04-06T00:00:00-03:00") })
      .where(and(eq(seasonClubs.seasonId, seasonId), eq(seasonClubs.clubId, club(t))));
  }
  await db.execute(`update futbolsa.season_clubs sc set total_shares = coalesce((select sum(p.shares) from futbolsa.positions p
    join futbolsa.wallets w on w.id = p.wallet_id where w.season_id = sc.season_id and p.club_id = sc.club_id), 0)`);

  // ---- 1. carga ----
  const refresh = (t, now) => refresher.refreshClub(seasonId, t, now, { fairValues: new Map([[t, 4000]]), inMatch: false });
  for (const t of TICKERS) await refresh(t, start);
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const clubWait = new Map(TICKERS.map((t) => [t, []]));
  const clubHold = new Map(TICKERS.map((t) => [t, []]));
  const houseWalletWait = [];
  const otherWalletWait = [];
  const total = seconds * rate;
  const t0 = performance.now();
  const pending = [];
  for (let i = 0; i < total; i++) {
    const due = t0 + (i * 1000) / rate;
    const delay = due - performance.now();
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    const ticker = i % 2 === 0 ? "FLA3" : TICKERS[1 + Math.floor(random() * 3)];
    const side = random() < 0.5 ? "buy" : "sell";
    const now = new Date(start.getTime() + 60_000 + (performance.now() - t0));
    const input = {
      seasonId,
      ticker,
      walletId: players[Math.floor(random() * players.length)],
      actor: "player",
      side,
      type: "limit",
      quantity: 1 + Math.floor(random() * 10),
      limitPrice: Math.round((4000 * (1 + (random() * 2 - 1) * 0.08)) / 10) * 10,
      now,
    };
    pending.push(
      (async () => {
        let begin, locked, walletsAsked, walletsGot;
        const result = await withTransaction(db, async (tx) => {
          begin = performance.now();
          await lockClubs(tx, seasonId, [ticker]);
          locked = performance.now();
          return service.placeOrder(tx, input, {
            afterReadBeforeLock: async () => void (walletsAsked = performance.now()),
            afterWalletsLocked: async () => void (walletsGot = performance.now()),
          });
        });
        const end = performance.now();
        clubWait.get(ticker).push(locked - begin);
        clubHold.get(ticker).push(end - locked);
        if (result.ok && walletsAsked !== undefined && walletsGot !== undefined) {
          const withHouse = result.trades.some((t) => t.buyerWalletId === treasury || t.sellerWalletId === treasury);
          (withHouse ? houseWalletWait : otherWalletWait).push(walletsGot - walletsAsked);
        }
      })(),
    );
    // a casa repõe a cotação de cada clube uma vez por segundo, no meio da carga
    if (i % rate === rate - 1) for (const t of TICKERS) pending.push(refresh(t, now));
  }
  await Promise.all(pending);
  const elapsed = (performance.now() - t0) / 1000;

  const lines = [`carga: ${total} ordens em ${elapsed.toFixed(1)} s (${(total / elapsed).toFixed(0)}/s), metade no FLA3`];
  for (const t of TICKERS) lines.push(`  ${t}: espera pela trava do clube ${fmt(clubWait.get(t))}; com a trava ${fmt(clubHold.get(t))}`);
  lines.push(`  espera pelas carteiras, negócio com a casa (tesouraria): ${fmt(houseWalletWait)}`);
  lines.push(`  espera pelas carteiras, sem a casa: ${fmt(otherWalletWait)}`);

  // ---- 2. fim de um leilão com 2.000 ordens ----
  const auctionTicker = "COR3";
  const auctionStart = new Date(start.getTime() + 30 * 60_000);
  await db
    .update(seasonClubs)
    .set({ auctionOpenedAt: auctionStart, auctionUntil: new Date(auctionStart.getTime() + 3 * 3600_000) })
    .where(and(eq(seasonClubs.seasonId, seasonId), eq(seasonClubs.clubId, club(auctionTicker))));
  // as cotações da casa que estavam no livro do COR3 ficam nele e entram no leilão como estão
  // cada carteira tem um teto de ordens abertas: mais jogadores, só com ações do COR3, para o livro chegar a 2.000
  const extra = await openPlayerWallets(db, seasonId, 60, 50_000_000);
  for (const w of extra) await give(w, { kind: "ipo_settle", clubId: club(auctionTicker), sharesDelta: 2_000, price: 4000, costBasis: "purchase" });
  await db.execute(`update futbolsa.season_clubs set total_shares = total_shares + ${extra.length * 2_000} where club_id = ${club(auctionTicker)} and season_id = ${seasonId}`);
  const auctionWallets = [...players, ...extra];
  let placed = 0;
  for (let i = 0; placed < AUCTION_ORDERS && i < AUCTION_ORDERS * 2; i += 40) {
    const batch = [];
    for (let j = i; j < i + 40; j++) {
      const side = j % 2 === 0 ? "buy" : "sell";
      // compras de R$ 40,00 a R$ 44,00 e vendas de R$ 36,00 a R$ 40,00: cruzam quase todas; 1 em 10 é da casa
      const limitPrice = side === "buy" ? 4000 + Math.floor(random() * 41) * 10 : 3600 + Math.floor(random() * 41) * 10;
      const house = j % 10 === 0 || j % 10 === 5;
      batch.push(
        service.place({
          seasonId,
          ticker: auctionTicker,
          walletId: house ? treasury : auctionWallets[j % auctionWallets.length],
          actor: house ? "house" : "player",
          side,
          type: "limit",
          quantity: 1 + Math.floor(random() * 5),
          limitPrice,
          now: new Date(auctionStart.getTime() + 60_000 + j),
        }),
      );
    }
    placed += (await Promise.all(batch)).filter((r) => r.ok).length;
  }
  const [{ n: inBook }] = (
    await db.execute(`select count(*)::int as n from futbolsa.orders where club_id = ${club(auctionTicker)} and status = 'open'`)
  ).rows;
  // quanto do fim do leilão vai no extrato (`post`, dois por negócio) e nos candles (`recordTrade`, um por negócio)
  const spent = { post: 0, recordTrade: 0 };
  for (const method of Object.keys(spent)) {
    const original = ledger[method].bind(ledger);
    ledger[method] = async (...args) => {
      const t = performance.now();
      try {
        return await original(...args);
      } finally {
        spent[method] += performance.now() - t;
      }
    };
  }
  let clubLocked, walletsAt;
  const closeStart = performance.now();
  const closeAt = new Date(auctionStart.getTime() + 3 * 3600_000 + 1_000);
  const closed = await closer.closeAuction(seasonId, auctionTicker, closeAt, {
    afterClubLock: async () => void (clubLocked = performance.now()),
    beforeWalletLock: async () => void (walletsAt = performance.now()),
  });
  const closeEnd = performance.now();
  if (!closed.closed) throw new Error(`o leilão não fechou: ${closed.reason}`);
  lines.push(
    `fim do leilão: ${inBook} ordens no livro, ${closed.trades.length} negócios a ${(Number(closed.price) / 100).toFixed(2)}, ` +
      `${closed.walletIds.length} carteiras (tesouraria ${closed.walletIds.includes(treasury) ? "entre elas" : "fora"})`,
    `  total ${(closeEnd - closeStart).toFixed(0)} ms; leitura do livro e preço único ${(walletsAt - clubLocked).toFixed(0)} ms; ` +
      `carteiras e tesouraria travadas até o COMMIT ${(closeEnd - walletsAt).toFixed(0)} ms`,
    `  dentro disso: extrato (portfolio.post) ${spent.post.toFixed(0)} ms; candles (recordTrade) ${spent.recordTrade.toFixed(0)} ms; ` +
      `o resto (negócio, ordens, trava das carteiras, COMMIT) ${(closeEnd - walletsAt - spent.post - spent.recordTrade).toFixed(0)} ms`,
  );
  console.log(lines.join("\n"));
} finally {
  await conn?.close();
  await admin(`drop database if exists "${name}" with (force)`);
}
