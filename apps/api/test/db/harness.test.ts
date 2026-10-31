import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { clubs } from "../../src/infra/db/schema/index.js";
import { adminQuery, createTestDatabase } from "../support/db.js";

describe("T1: um banco de teste por arquivo", () => {
  it("cada banco nasce migrado e não vê o que o outro grava", async () => {
    const a = await createTestDatabase(2);
    const b = await createTestDatabase(2);
    try {
      await a.db.insert(clubs).values({ ticker: "ZZZ3", name: "Clube de teste" });
      await b.db.insert(clubs).values({ ticker: "ZZZ3", name: "Outro clube de teste" });
      const [inA] = await a.db.select().from(clubs).where(eq(clubs.ticker, "ZZZ3"));
      expect(inA!.name).toBe("Clube de teste");
      const schemas = await a.db.execute(sql`select 1 from information_schema.schemata where schema_name = 'futbolsa'`);
      expect(schemas.rows).toHaveLength(1);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("o banco do arquivo some depois de fechado", async () => {
    const t = await createTestDatabase(1);
    await t.close();
    const result = await adminQuery(`select 1 from pg_database where datname = '${t.name}'`);
    expect(result.rows).toHaveLength(0);
  });
});
