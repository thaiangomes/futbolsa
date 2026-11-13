import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { rankingRecalcRequests, rankingRows, rankingSnapshots } from "../../src/infra/db/schema/index.js";
import { useTestDatabase } from "../support/db.js";
import { openPlayerWallets, seedSeason, T0 } from "../support/fixtures.js";

// T2: migração 0003 (fila de recálculo e restrição de ranking_rows).

describe("migração dos rankings", () => {
  const database = useTestDatabase(4);

  it("um pedido aberto por temporada; um concluído convive com um novo", async () => {
    const { seasonId } = await seedSeason(database.db);
    const req = { seasonId, fromAt: T0, reason: "pagamento", requestedAt: T0 };
    const [first] = await database.db.insert(rankingRecalcRequests).values(req).returning({ id: rankingRecalcRequests.id });
    await expect(database.db.insert(rankingRecalcRequests).values(req)).rejects.toThrow();
    await database.db.execute(sql`update futbolsa.ranking_recalc_requests set done_at = ${T0.toISOString()}::timestamptz where id = ${first!.id}`);
    await expect(database.db.insert(rankingRecalcRequests).values(req)).resolves.toBeDefined();
  });

  it("uma linha de ranking com base negativa entra, mas posição 0 não", async () => {
    const { seasonId } = await seedSeason(database.db, 2028);
    const [wallet] = await openPlayerWallets(database.db, seasonId, 1);
    const [snap] = await database.db
      .insert(rankingSnapshots)
      .values({ seasonId, period: "month", periodKey: "2028-05", closedAt: T0, botsIncluded: false, createdAt: T0 })
      .returning({ id: rankingSnapshots.id });
    await expect(database.db.insert(rankingRows).values({ snapshotId: snap!.id, walletId: wallet!, base: -25_000, equity: -10_000, position: 1 })).resolves.toBeDefined();
  });
});
