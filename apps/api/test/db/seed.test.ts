import { CLUBS } from "@futbolsa/engine/data/clubs";
import { describe, expect, it } from "vitest";
import { seed } from "../../src/infra/db/seed.js";
import { bots, clubs, seasons, wallets } from "../../src/infra/db/schema/index.js";
import { useTestDatabase } from "../support/db.js";

describe("T4: dados iniciais", () => {
  const t = useTestDatabase(2);

  it("grava os 20 clubes de CLUBS e a temporada em preparação com os padrões do formador", async () => {
    await seed(t.db, 2027);
    const rows = await t.db.select().from(clubs);
    expect(rows).toHaveLength(20);
    expect(rows.map((r) => r.ticker).sort()).toEqual(CLUBS.map((c) => c.id).sort());
    expect(rows.find((r) => r.ticker === "FLA3")!.name).toBe("Flamengo");
    const [season] = await t.db.select().from(seasons);
    expect(season).toMatchObject({
      year: 2027,
      status: "preparing",
      mmQuantityBp: 25,
      mmMatchQuantityBp: 6,
      mmLotBp: 2000,
      mmMinSideQty: 10,
      mmMatchMinSideQty: 3,
      botsInRankings: false,
    });
  });

  it("rodar de novo não muda nada e não cria carteira nem bot", async () => {
    await seed(t.db, 2027);
    expect(await t.db.select().from(clubs)).toHaveLength(20);
    expect(await t.db.select().from(seasons)).toHaveLength(1);
    expect(await t.db.select().from(wallets)).toHaveLength(0);
    expect(await t.db.select().from(bots)).toHaveLength(0);
  });
});
