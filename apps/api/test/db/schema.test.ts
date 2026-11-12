import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/infra/db/client.js";
import { MIGRATIONS_FOLDER } from "../../src/infra/db/migrate.js";
import { payoutEvents, positions, users, wallets, ipoBids } from "../../src/infra/db/schema/index.js";
import { useTestDatabase } from "../support/db.js";
import { createUser, listClubs, openPlayerWallets, seedSeason, T0 } from "../support/fixtures.js";

/** As 33 tabelas de "Modelo de dados" da Arquitetura da Fase 1. */
const TABLES = [
  "users", "auth_identities", "invites", "bots", "clubs", "seasons", "season_clubs", "season_rules",
  "cup_phases", "season_cups", "standings", "matches", "wallets", "positions", "wallet_entries",
  "ipo_bids", "ipo_results", "ipo_allocations", "orders", "trades", "market_refresh_requests", "candles",
  "payout_events", "payout_holdings", "payout_credits", "ranking_snapshots", "ranking_rows", "ranking_recalc_requests",
  "equity_daily", "portfolio_snapshots", "season_results", "admin_log", "idempotency_keys",
];

/** Colunas de dinheiro (centavos). */
const MONEY: Record<string, string[]> = {
  season_clubs: ["band_center", "band_floor", "band_ceiling", "ipo_price", "last_price", "tunnel_ref"],
  season_rules: ["a_per_point", "b_per_point", "promotion_per_share"],
  cup_phases: ["per_share"],
  wallets: ["cash", "reserved_cash"],
  positions: ["cost", "realized", "dividends"],
  wallet_entries: ["cash_delta", "reserved_cash_delta", "price", "realized", "cash_after"],
  ipo_bids: ["max_price", "reserved"],
  ipo_results: ["cut_price"],
  ipo_allocations: ["paid", "refunded"],
  orders: ["limit_price", "reserved_cash"],
  trades: ["price", "price_before"],
  candles: ["open", "high", "low", "close"],
  payout_events: ["per_share"],
  payout_credits: ["amount"],
  ranking_rows: ["base", "equity"],
  equity_daily: ["equity"],
  season_results: ["final_equity", "base"],
};

/** Quantidades de ações. */
const SHARES: Record<string, string[]> = {
  season_clubs: ["total_shares"],
  positions: ["shares", "reserved_shares"],
  wallet_entries: ["shares_delta", "reserved_shares_delta"],
  ipo_bids: ["quantity"],
  ipo_allocations: ["shares"],
  orders: ["quantity", "filled"],
  trades: ["quantity"],
  payout_holdings: ["shares"],
};

async function columnTypes(db: Database): Promise<Map<string, string>> {
  const result = await db.execute(
    sql`select table_name, column_name, data_type from information_schema.columns where table_schema = 'futbolsa'`,
  );
  return new Map(result.rows.map((r) => [`${r.table_name}.${r.column_name}`, String(r.data_type)]));
}

/** O código SQLSTATE e o nome da restrição do erro do Postgres (o Drizzle embrulha). */
async function rejection(promise: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: { code?: string; constraint?: string } }).cause ?? (error as never);
    return { code: cause.code, constraint: cause.constraint };
  }
  throw new Error("era para o banco recusar");
}

describe("T2: esquema completo e migração inicial", () => {
  const t = useTestDatabase();
  let seasonId: number;
  let clubIds: Map<string, number>;

  beforeAll(async () => {
    ({ seasonId, clubIds } = await seedSeason(t.db));
    await listClubs(t.db, seasonId, clubIds, ["FLA3", "PAL3"]);
  });

  it("as 33 tabelas da arquitetura existem no esquema futbolsa, nem mais nem menos", async () => {
    const result = await t.db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'futbolsa' order by table_name`,
    );
    expect(result.rows.map((r) => r.table_name)).toEqual([...TABLES].sort());
    const pub = await t.db.execute(sql`select table_name from information_schema.tables where table_schema = 'public'`);
    expect(pub.rows).toEqual([]);
  });

  it("dinheiro em bigint, ações em integer e todo horário em timestamptz", async () => {
    const types = await columnTypes(t.db);
    for (const [table, cols] of Object.entries(MONEY)) {
      for (const col of cols) expect(types.get(`${table}.${col}`), `${table}.${col}`).toBe("bigint");
    }
    expect(types.get("season_rules.a_placement")).toBe("ARRAY");
    for (const [table, cols] of Object.entries(SHARES)) {
      for (const col of cols) expect(types.get(`${table}.${col}`), `${table}.${col}`).toBe("integer");
    }
    const timestamps = [...types].filter(([, type]) => type.startsWith("timestamp"));
    expect(timestamps.length).toBeGreaterThan(30);
    for (const [col, type] of timestamps) expect(type, col).toBe("timestamp with time zone");
  });

  it("apelido e e-mail únicos sem diferenciar maiúsculas", async () => {
    await t.db.insert(users).values({ email: "Ana@Exemplo.com", nickname: "Ana_1" });
    expect((await rejection(t.db.insert(users).values({ email: "x@exemplo.com", nickname: "ana_1" }))).constraint).toBe(
      "users_nickname_lower_key",
    );
    expect((await rejection(t.db.insert(users).values({ email: "ana@exemplo.COM", nickname: "outra" }))).constraint).toBe(
      "users_email_lower_key",
    );
  });

  it("uma carteira por usuário, por bot e uma tesouraria por temporada, com exatamente um dono", async () => {
    const userId = await createUser(t.db);
    await t.db.insert(wallets).values({ seasonId, ownerType: "user", userId, enteredAt: T0 });
    expect((await rejection(t.db.insert(wallets).values({ seasonId, ownerType: "user", userId, enteredAt: T0 }))).constraint).toBe(
      "wallets_season_user_key",
    );
    await t.db.insert(wallets).values({ seasonId, ownerType: "treasury", enteredAt: T0 });
    expect((await rejection(t.db.insert(wallets).values({ seasonId, ownerType: "treasury", enteredAt: T0 }))).constraint).toBe(
      "wallets_season_treasury_key",
    );
    expect(
      (await rejection(t.db.insert(wallets).values({ seasonId, ownerType: "treasury", userId: await createUser(t.db), enteredAt: T0 })))
        .constraint,
    ).toBe("wallets_owner_check");
  });

  it("reserva nunca negativa nem acima do total; caixa negativo só sem reserva (admin 15)", async () => {
    const [w] = await openPlayerWallets(t.db, seasonId, 1, 0);
    const reject = (values: Partial<typeof wallets.$inferInsert>) =>
      rejection(t.db.update(wallets).set(values).where(sql`${wallets.id} = ${w}`));
    expect((await reject({ reservedCash: -1 })).constraint).toBe("wallets_reserved_cash_check");
    expect((await reject({ cash: 100, reservedCash: 200 })).constraint).toBe("wallets_cash_check");
    expect((await reject({ cash: -500, reservedCash: 100 })).constraint).toBe("wallets_cash_check");
    // caixa negativo sem reserva é aceito (estorno)
    await t.db.update(wallets).set({ cash: -500, reservedCash: 0 }).where(sql`${wallets.id} = ${w}`);
    const club = clubIds.get("FLA3")!;
    expect(
      (await rejection(t.db.insert(positions).values({ walletId: w!, clubId: club, shares: 10, reservedShares: 11 }))).constraint,
    ).toBe("positions_shares_check");
    expect(
      (await rejection(t.db.insert(positions).values({ walletId: w!, clubId: club, shares: 10, reservedShares: -1 }))).constraint,
    ).toBe("positions_shares_check");
  });

  it("uma oferta por clube por carteira no IPO", async () => {
    const [w] = await openPlayerWallets(t.db, seasonId, 1);
    const bid = { seasonId, clubId: clubIds.get("FLA3")!, walletId: w!, quantity: 10, maxPrice: 3500, reserved: 35000, createdAt: T0, updatedAt: T0 };
    await t.db.insert(ipoBids).values(bid);
    expect((await rejection(t.db.insert(ipoBids).values(bid))).constraint).toBe("ipo_bids_season_club_wallet_key");
  });

  it("um evento de pagamento vigente por clube e chave; a versão substituída convive com a nova", async () => {
    const event = {
      seasonId,
      clubId: clubIds.get("FLA3")!,
      eventKey: "points:brasileirao-a:5:FLA3",
      kind: "points",
      reason: "3 pontos, rodada 5",
      competition: "brasileirao-a",
      round: 5,
      perShare: 30,
      closedAt: T0,
      createdAt: T0,
    };
    const [first] = await t.db.insert(payoutEvents).values(event).returning();
    expect((await rejection(t.db.insert(payoutEvents).values(event))).constraint).toBe("payout_events_current_key");
    await t.db.update(payoutEvents).set({ status: "superseded" }).where(sql`${payoutEvents.id} = ${first!.id}`);
    await t.db.insert(payoutEvents).values({ ...event, perShare: 10, version: 2, supersedesId: first!.id });
  });

  it("valores fora da lista de cada coluna de estado são recusados", async () => {
    expect((await rejection(t.db.insert(users).values({ email: "z@exemplo.com", nickname: "z_1", role: "dono" }))).code).toBe("23514");
    expect((await rejection(t.db.execute(sql`update futbolsa.seasons set status = 'aberta' where id = ${seasonId}`))).code).toBe("23514");
  });

  it("a consulta do livro usa o índice das ordens abertas", async () => {
    const plan = await t.db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      return tx.execute(
        sql`explain select id from futbolsa.orders
            where club_id = 1 and side = 'sell' and status = 'open'
            order by limit_price, id limit 5`,
      );
    });
    expect(plan.rows.map((r) => r["QUERY PLAN"]).join("\n")).toContain("orders_book_idx");
  });

  it("o esquema em TypeScript bate com as migrações: drizzle-kit generate não gera nada novo", () => {
    const out = mkdtempSync(join(tmpdir(), "futbolsa-drizzle-"));
    try {
      cpSync(MIGRATIONS_FOLDER, out, { recursive: true });
      const before = readdirSync(out).sort();
      const require = createRequire(import.meta.url);
      // o pacote só exporta "." e "./api"; o executável fica ao lado do index.js
      const bin = join(dirname(require.resolve("drizzle-kit")), "bin.cjs");
      const apiDir = fileURLToPath(new URL("../..", import.meta.url));
      execFileSync(
        process.execPath,
        [bin, "generate", "--dialect", "postgresql", "--schema", "./src/infra/db/schema/index.ts", "--out", out],
        { cwd: apiDir, stdio: "pipe" },
      );
      expect(readdirSync(out).sort()).toEqual(before);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
