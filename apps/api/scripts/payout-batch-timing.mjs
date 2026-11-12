// Medição do tempo que um lote de crédito dos pagamentos segura as travas (Plano dos dividendos e pagamentos, T8 e
// "Pendente de informação": o lote de 200 carteiras é proposta; Arquitetura da Fase 1, "Escala"). Não é teste
// automático: o tempo depende da máquina. Num banco próprio, criado e apagado aqui, com 5.000 donos de um clube:
//
// 1. Aprovação (versão 1, dividendo): a liquidação em lotes de 200 carteiras (`SettleCreditsService.settleEvent`).
//    Por lote, o tempo com as travas (da primeira trava, a temporada, ao COMMIT; as carteiras do lote ficam travadas
//    nesse tempo), quanto dele vai no extrato (`portfolio.post`) e no aviso `wallet.changed` (`WalletEvents.posted`),
//    e o intervalo entre um lote e o seguinte (a consulta `dues()` do cursor, fora da transação).
// 2. Correção (versão 2, complemento): a mesma liquidação numa versão gravada por uma correção, em que `dues()` (T7)
//    soma o que as versões anteriores já creditaram a cada carteira.
// 3. O custo de `dues()` sozinho, nos três formatos que a liquidação usa (o cursor de 200, as 200 carteiras do lote
//    dentro da transação e a temporada inteira de `settlingEventIds`, que a prévia e a correção consultam), com tudo
//    a pagar e com tudo pago.
//
//   TEST_DATABASE_URL=... node --import tsx apps/api/scripts/payout-batch-timing.mjs [donos=5000] [lote=200]
//
// (o servidor de TEST_DATABASE_URL só ganha um banco `futbolsa_timing_*`, apagado no fim; a URL nunca é impressa)
//
// Resultado em 2026-11-11 (notebook de 8 GB, Postgres 17 nativo, pool de 20 conexões, 5.000 donos, lotes de 200):
//   aprovação: 5.000 créditos em 25 lotes, 32,9 s (152 carteiras/s)
//     travas por lote: p50 1.270 ms, p95 1.421 ms, máx 1.578 ms; dentro do lote, em média, extrato 966 ms (~4,8 ms
//     por `post`), wallet.changed 169 ms (a contagem do extrato da carteira) e o resto 160 ms (travas, dues() do
//     lote, payout_credits, COMMIT); entre lotes (o cursor) p50 20 ms, p95 37 ms
//     dues() sozinho: cursor de 200 18 a 34 ms; as 200 carteiras do lote 8 ms; settlingEventIds 28 a 57 ms
//   correção (versão 2): 5.000 créditos em 25 lotes, 43,1 s (116 carteiras/s)
//     travas por lote: p50 1.323 ms, p95 1.409 ms, máx 1.419 ms (o mesmo da aprovação: o dues() do lote fica em 10 ms)
//     entre lotes (o cursor) p50 597 ms, p95 719 ms: no meio da liquidação o planejador junta as carteiras por laço
//     com filtro (estatísticas de `payout_credits` velhas logo depois dos lançamentos), fora das travas
//     dues() sozinho, antes e depois: cursor de 200 26 a 63 ms; as 200 do lote 10 ms; settlingEventIds 55 a 62 ms
//   => cada lote de 200 segura as carteiras ~1,3 s; uma ordem de um desses donos espera isso com o clube travado.
//      ~6,5 ms por carteira, quase tudo no `portfolio.post` um a um (a saída é o `postMany` da F11 ou lotes menores).
// Revisão T10 (mesma máquina, `dues()` reescrita em conjuntos, sem subconsulta por carteira):
//   lotes de 200: correção 32,7 s; entre lotes (o cursor) p50 24 ms (era 597 ms); travas por lote p50 1.277 ms
//   lotes de 50 (o SETTLE_BATCH novo): aprovação 34,3 s, correção 35,0 s; travas por lote p50 319 ms, p95 345 ms
//   (e, à parte, 200 eventos pagos de 2.000 donos: settlingEventIds da temporada de 17,7 s para 0,7 s)
import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import pg from "pg";

const owners = Number(process.argv[2] ?? 5_000);
const batchSize = Number(process.argv[3] ?? 200);

const { connect } = await import("../src/infra/db/client.ts");
const { runMigrations } = await import("../src/infra/db/migrate.ts");
const { lockWallets, withTransaction } = await import("../src/infra/db/index.ts");
const { FixedClock } = await import("../src/infra/clock/index.ts");
const { adminLog, payoutEvents, users } = await import("../src/infra/db/schema/index.ts");
const { post } = await import("../src/modules/portfolio/ledger/index.ts");
const { PortfolioLedger, WalletEvents } = await import("../src/modules/portfolio/index.ts");
const { MemoryEventBus } = await import("../src/infra/realtime/memory-bus.ts");
const market = await import("../src/modules/market/index.ts");
const { SettleCreditsService } = await import("../src/modules/admin/payouts/settle-credits.ts");
const { SettleReversalService } = await import("../src/modules/admin/payouts/settle-reversal.ts");
const { dues, settlingEventIds } = await import("../src/modules/admin/payouts/settlement.ts");
const { marketSeason } = await import("../test/market/helpers.ts");
const { openWallets, T0 } = await import("../test/support/fixtures.ts");
const { eq } = await import("drizzle-orm");

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
const fmt = (values) =>
  `p50 ${pct(values, 50).toFixed(1)} ms, p95 ${pct(values, 95).toFixed(1)} ms, máx ${Math.max(...values).toFixed(1)} ms (n=${values.length})`;
const sum = (values) => values.reduce((a, b) => a + b, 0);
/** Mediana de 5 execuções de uma consulta. */
async function timed(fn) {
  const runs = [];
  let result;
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    result = await fn();
    runs.push(performance.now() - t);
  }
  return { ms: pct(runs, 50), result };
}

const name = `futbolsa_timing_${process.pid}_${randomBytes(3).toString("hex")}`;
await admin(`create database "${name}"`);
const url = withDatabase(name);
let conn;
try {
  await runMigrations(url);
  conn = connect(url, 20);
  const db = conn.db;
  const { seasonId, clubIds } = await marketSeason(db, { tickers: ["FLA3"], totalShares: owners * 200 });
  const clubId = clubIds.get("FLA3");
  const closedAt = new Date("2027-06-06T20:00:00Z");
  const clock = new FixedClock(new Date("2027-06-06T22:00:00Z"));

  // ---- os 5.000 donos: usuários em lote, carteiras e ações (de 10 a 200 FLA3 cada) antes do fechamento ----
  const setupStart = performance.now();
  const wallets = [];
  for (let i = 0; i < owners; i += 500) {
    const n = Math.min(500, owners - i);
    const rows = await db
      .insert(users)
      .values(Array.from({ length: n }, (_, j) => ({ email: `dono${i + j}@exemplo.com`, nickname: `dono_${i + j}` })))
      .returning({ id: users.id });
    wallets.push(...(await openWallets(db, seasonId, rows.map((r) => ({ type: "user", userId: r.id })), 1_000_000)));
  }
  const sharesOf = (i) => 10 + ((i * 37) % 191);
  for (let i = 0; i < wallets.length; i += 250) {
    const chunk = wallets.slice(i, i + 250);
    await withTransaction(db, async (tx) => {
      await lockWallets(tx, chunk);
      for (const [j, walletId] of chunk.entries()) {
        await post(tx, { walletId, at: T0, kind: "ipo_settle", clubId, sharesDelta: sharesOf(i + j), price: 4000, costBasis: "purchase" });
      }
    });
  }
  const [actor] = await db.insert(users).values({ email: "admin@exemplo.com", nickname: "admin_medicao", role: "admin" }).returning({ id: users.id });
  const setupSeconds = (performance.now() - setupStart) / 1000;

  // ---- a liquidação, com as medições por lote ----
  const ledger = new PortfolioLedger();
  const walletEvents = new WalletEvents(new MemoryEventBus(clock));
  const cancels = new market.CancelService(db, ledger);
  const reversal = new SettleReversalService(db, ledger, walletEvents, cancels, clock);
  const settle = new SettleCreditsService(db, reversal);
  settle.batchSize = batchSize;
  let spent = { post: 0, events: 0 };
  const measure = (target, method, key) => {
    const original = target[method].bind(target);
    target[method] = async (...args) => {
      const t = performance.now();
      try {
        return await original(...args);
      } finally {
        spent[key] += performance.now() - t;
      }
    };
  };
  measure(ledger, "post", "post");
  measure(walletEvents, "posted", "events");
  let batches = [];
  let lastCommit = null;
  const originalBatch = settle.creditBatch.bind(settle);
  settle.creditBatch = async (tx, event, walletIds) => {
    const start = performance.now();
    const gap = lastCommit === null ? null : start - lastCommit;
    spent = { post: 0, events: 0 };
    const result = await originalBatch(tx, event, walletIds);
    const inside = { ...spent };
    tx.afterCommit(() => {
      lastCommit = performance.now();
      batches.push({ hold: lastCommit - start, gap, post: inside.post, events: inside.events, credits: result.credits.length });
    });
    return result;
  };

  async function event(values) {
    const [row] = await db
      .insert(payoutEvents)
      .values({ seasonId, clubId, kind: "points", competition: "brasileirao-a", round: 10, closedAt, createdAt: closedAt, status: "approved", approvedAt: clock.now(), ...values })
      .returning();
    return row;
  }

  /** O custo de `dues()` nos três formatos que a liquidação usa. */
  async function duesCost(eventId) {
    const cursor = await timed(() => dues(db, { eventId, limit: batchSize }));
    const middle = wallets[Math.floor(wallets.length / 2)];
    const cursorMiddle = await timed(() => dues(db, { eventId, afterWallet: middle, limit: batchSize }));
    const batchWallets = wallets.slice(Math.floor(wallets.length / 2), Math.floor(wallets.length / 2) + batchSize);
    const inBatch = await timed(() => dues(db, { eventId, walletIds: batchWallets }));
    const season = await timed(() => settlingEventIds(db, seasonId));
    return [
      `cursor (primeiros ${batchSize}) ${cursor.ms.toFixed(1)} ms (${cursor.result.length} linhas)`,
      `cursor no meio ${cursorMiddle.ms.toFixed(1)} ms (${cursorMiddle.result.length})`,
      `as ${batchSize} carteiras do lote ${inBatch.ms.toFixed(1)} ms (${inBatch.result.length})`,
      `settlingEventIds da temporada ${season.ms.toFixed(1)} ms (${season.result.length} eventos)`,
    ].join("; ");
  }

  async function run(label, row) {
    const before = await duesCost(row.id);
    batches = [];
    lastCommit = null;
    const t = performance.now();
    const summary = await settle.settleEvent(row.id);
    const total = performance.now() - t;
    const after = await duesCost(row.id);
    const holds = batches.map((b) => b.hold);
    const gaps = batches.flatMap((b) => (b.gap === null ? [] : [b.gap]));
    const rest = batches.map((b) => b.hold - b.post - b.events);
    return [
      `${label}: ${summary.credited} créditos em ${batches.length} lotes, ${(total / 1000).toFixed(1)} s no total (${(summary.credited / (total / 1000)).toFixed(0)} carteiras/s)`,
      `  travas por lote (temporada, evento FOR SHARE e as ${batchSize} carteiras, até o COMMIT): ${fmt(holds)}`,
      `    dentro do lote: extrato (portfolio.post) ${(sum(batches.map((b) => b.post)) / batches.length).toFixed(1)} ms; ` +
        `wallet.changed (WalletEvents.posted) ${(sum(batches.map((b) => b.events)) / batches.length).toFixed(1)} ms; ` +
        `o resto (travas, dues() do lote, motivo, payout_credits, COMMIT) ${(sum(rest) / batches.length).toFixed(1)} ms (médias)`,
      `  entre um lote e o seguinte (dues() do cursor, fora da transação): ${fmt(gaps)}`,
      `  dues() antes (tudo a lançar): ${before}`,
      `  dues() depois (nada a lançar): ${after}`,
    ];
  }

  // ---- 1. aprovação: a versão 1, R$ 0,30 por ação ----
  const key = "points|brasileirao-a|10|FLA3";
  const v1 = await event({ eventKey: key, reason: "3 pontos na rodada 10", perShare: 30 });
  await db.execute(`insert into futbolsa.payout_holdings (event_id, wallet_id, shares)
    select ${v1.id}, p.wallet_id, p.shares from futbolsa.positions p join futbolsa.wallets w on w.id = p.wallet_id
    where w.season_id = ${seasonId} and p.club_id = ${clubId} and p.shares > 0`);
  const lines = [`montagem: ${wallets.length} donos do FLA3 em ${setupSeconds.toFixed(1)} s; lotes de ${batchSize} carteiras`];
  lines.push(...(await run("aprovação (versão 1, dividendo)", v1)));

  // ---- 2. correção: a versão 2, R$ 0,40 por ação (complemento de R$ 0,10), com a foto copiada ----
  await db.update(payoutEvents).set({ status: "superseded" }).where(eq(payoutEvents.id, v1.id));
  const v2 = await event({ eventKey: key, reason: "3 pontos na rodada 10", perShare: 40, version: 2, supersedesId: v1.id });
  await db.execute(`insert into futbolsa.payout_holdings (event_id, wallet_id, shares) select ${v2.id}, wallet_id, shares from futbolsa.payout_holdings where event_id = ${v1.id}`);
  await db.insert(adminLog).values({
    actorId: actor.id,
    at: clock.now(),
    action: "payout.correct",
    targetType: "payout_correction",
    targetId: "medicao",
    after: { eventIds: [v2.id] },
    reason: "medição do lote",
  });
  lines.push(...(await run("correção (versão 2, complemento; dues() soma a versão 1)", v2)));
  console.log(lines.join("\n"));
} finally {
  await conn?.close();
  await admin(`drop database if exists "${name}" with (force)`);
}
