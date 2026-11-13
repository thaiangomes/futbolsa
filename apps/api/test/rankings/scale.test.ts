import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { FixedClock } from "../../src/infra/clock/index.js";
import { seasons } from "../../src/infra/db/schema/index.js";
import { closeAtOfMonth } from "../../src/modules/rankings/base.js";
import { CloseService } from "../../src/modules/rankings/close.service.js";
import { currentSnapshot } from "../../src/modules/rankings/snapshots.js";
import { useTestDatabase } from "../support/db.js";
import { br, inTx, portfolioSeason, type PortfolioSeason } from "./support.js";

// T11: a medida do fechamento do mês com 10 mil carteiras e 20 clubes. Só roda com RANKINGS_SCALE=1 (leva alguns segundos
// a mais e serve para anotar o tempo no plano; não há teto prometido).

const run = process.env.RANKINGS_SCALE === "1" ? describe : describe.skip;

run("medida do fechamento com 10 mil carteiras", () => {
  const database = useTestDatabase(6);
  let s: PortfolioSeason;
  beforeAll(async () => {
    s = await portfolioSeason(database.db);
    // até 20 clubes listados
    await database.db.execute(sql`
      insert into futbolsa.season_clubs (season_id, club_id, division, total_shares, last_price)
      select ${s.seasonId}, c.id, 'A', 3000, 4000 from futbolsa.clubs c
      where c.ticker is not null and c.id not in (select club_id from futbolsa.season_clubs where season_id = ${s.seasonId}) order by c.id limit 16`);
    await database.db.update(seasons).set({ ipoOpensAt: br("2027-04-01 10:00") }).where(eq(seasons.id, s.seasonId));
    await database.db.execute(sql`
      insert into futbolsa.users (email, nickname, terms_accepted_at)
      select 'esc' || g || '@exemplo.com', 'esc_' || g, now() from generate_series(1, 10000) g`);
    await database.db.execute(sql`
      insert into futbolsa.wallets (season_id, owner_type, user_id, cash, entered_at)
      select ${s.seasonId}, 'user', u.id, 5000000 + (random() * 2000000)::int, '2027-04-02T13:00:00Z'::timestamptz
      from futbolsa.users u where u.nickname like 'esc\_%'`);
    await database.db.execute(sql`
      insert into futbolsa.positions (wallet_id, club_id, shares, cost)
      select w.id, c.club_id, 10 + (random() * 100)::int, 0
      from futbolsa.wallets w cross join (select club_id from futbolsa.season_clubs where season_id = ${s.seasonId} order by club_id limit 5) c
      where w.season_id = ${s.seasonId} and w.owner_type = 'user'`);
  });

  it("fecha o mês e mede o tempo", async () => {
    const service = new CloseService(database.db, new FixedClock(br("2027-06-01 12:00")));
    const started = performance.now();
    await inTx(database.db, (tx) => service.closeMonth(tx, { seasonId: s.seasonId, monthKey: "2027-05", at: closeAtOfMonth("2027-05") }));
    const seconds = (performance.now() - started) / 1000;
    const head = await inTx(database.db, (tx) => currentSnapshot(tx, s.seasonId, "month", "2027-05"));
    const [{ n }] = (await database.db.execute(sql`select count(*)::int as n from futbolsa.ranking_rows where snapshot_id = ${head!.id}`)).rows as [{ n: number }];
    console.log(`fechamento de 2027-05 com ${n} carteiras: ${seconds.toFixed(1)} s`);
    expect(n).toBeGreaterThanOrEqual(10_000);
  }, 300_000);
});
