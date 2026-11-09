import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { orders, seasonClubs, trades } from "../../src/infra/db/schema/index.js";
import { useTestDatabase } from "../support/db.js";
import { listClubs, openPlayerWallets, seedSeason, T0 } from "../support/fixtures.js";

/** L3 do Plano do livro de ofertas e formador: colunas do túnel e do leilão (migração do túnel). */

async function errorOf(promise: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: { code?: string; constraint?: string } }).cause ?? (error as never);
    return { code: cause.code, constraint: cause.constraint };
  }
  throw new Error("era para o banco recusar");
}

describe("L3: colunas do túnel e do leilão", () => {
  const t = useTestDatabase();
  let seasonId: number;
  let clubId: number;
  let wallets: number[];

  beforeAll(async () => {
    const seeded = await seedSeason(t.db);
    seasonId = seeded.seasonId;
    await listClubs(t.db, seasonId, seeded.clubIds, ["FLA3"]);
    clubId = seeded.clubIds.get("FLA3")!;
    wallets = await openPlayerWallets(t.db, seasonId, 2);
  });

  it("as colunas novas existem com os tipos certos", async () => {
    const result = await t.db.execute(
      sql`select table_name, column_name, data_type, is_nullable from information_schema.columns
          where table_schema = 'futbolsa' and (
            (table_name = 'season_clubs' and column_name in ('tunnel_ref', 'tunnel_ref_day', 'auction_opened_at', 'auction_until'))
            or (table_name = 'trades' and column_name in ('price_before', 'in_auction')))`,
    );
    const columns = new Map(result.rows.map((r) => [`${r.table_name}.${r.column_name}`, { type: String(r.data_type), nullable: r.is_nullable === "YES" }]));
    expect(columns.get("season_clubs.tunnel_ref")).toEqual({ type: "bigint", nullable: true });
    expect(columns.get("season_clubs.tunnel_ref_day")).toEqual({ type: "timestamp with time zone", nullable: true });
    expect(columns.get("season_clubs.auction_opened_at")).toEqual({ type: "timestamp with time zone", nullable: true });
    expect(columns.get("season_clubs.auction_until")).toEqual({ type: "timestamp with time zone", nullable: true });
    expect(columns.get("trades.price_before")).toEqual({ type: "bigint", nullable: false });
    expect(columns.get("trades.in_auction")).toEqual({ type: "boolean", nullable: false });
  });

  it("um clube começa fora de leilão e sem referência", async () => {
    const [row] = await t.db.select().from(seasonClubs).where(eq(seasonClubs.clubId, clubId));
    expect(row).toMatchObject({ tunnelRef: null, tunnelRefDay: null, auctionOpenedAt: null, auctionUntil: null });
  });

  it("o leilão aberto tem início e fim; parado pela suspensão tem só o início; fim sem início é recusado", async () => {
    const where = eq(seasonClubs.clubId, clubId);
    // em leilão
    await t.db.update(seasonClubs).set({ auctionOpenedAt: T0, auctionUntil: new Date(T0.getTime() + 3 * 3_600_000) }).where(where);
    // parado pela suspensão: sem fim
    await t.db.update(seasonClubs).set({ auctionUntil: null }).where(where);
    // fim sem início
    await t.db.update(seasonClubs).set({ auctionOpenedAt: null }).where(where);
    const refusal = await errorOf(t.db.update(seasonClubs).set({ auctionUntil: T0 }).where(where));
    expect(refusal).toEqual({ code: "23514", constraint: "season_clubs_auction_check" });
    await t.db.update(seasonClubs).set({ auctionOpenedAt: null, auctionUntil: null }).where(where);
  });

  it("a referência do túnel é um preço positivo", async () => {
    const refusal = await errorOf(t.db.update(seasonClubs).set({ tunnelRef: 0 }).where(eq(seasonClubs.clubId, clubId)));
    expect(refusal.constraint).toBe("season_clubs_tunnel_ref_check");
  });

  it("livro 44 e P12: price_before e in_auction são obrigatórios no negócio", async () => {
    const base = { seasonId, clubId, type: "limit", quantity: 1, filled: 1, limitPrice: 4000, status: "filled", createdAt: T0, updatedAt: T0 };
    const [buy] = await t.db.insert(orders).values({ ...base, walletId: wallets[0]!, side: "buy" }).returning({ id: orders.id });
    const [sell] = await t.db.insert(orders).values({ ...base, walletId: wallets[1]!, side: "sell" }).returning({ id: orders.id });
    const trade = {
      seasonId,
      clubId,
      at: T0,
      price: 4000,
      quantity: 1,
      buyOrderId: buy!.id,
      sellOrderId: sell!.id,
      buyerWalletId: wallets[0]!,
      sellerWalletId: wallets[1]!,
    };
    // `as never`: o tipo já exige os campos; o teste prova que o banco também
    expect((await errorOf(t.db.insert(trades).values({ ...trade, inAuction: false } as never))).code).toBe("23502");
    expect((await errorOf(t.db.insert(trades).values({ ...trade, priceBefore: 4000 } as never))).code).toBe("23502");
    await t.db.insert(trades).values({ ...trade, priceBefore: 3900, inAuction: true });
    const [saved] = await t.db.select().from(trades);
    expect(saved).toMatchObject({ priceBefore: 3900, inAuction: true });
  });
});
