import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { badgeAbbrOf, CLUB_BADGES } from "@futbolsa/engine/data/clubBadges";
import { describe, expect, it } from "vitest";
import { badgeColumns } from "../../src/infra/db/club-badge.js";
import { MIGRATIONS_FOLDER } from "../../src/infra/db/migrate.js";
import { seed } from "../../src/infra/db/seed.js";
import { clubs } from "../../src/infra/db/schema/index.js";
import { useTestDatabase } from "../support/db.js";

// Item 8 da fila da partida de teste: os selos dos clubes (cores, padrão e sigla) gravados no banco, a partir do arquivo de dados.

describe("selos dos clubes no banco", () => {
  const database = useTestDatabase(4);

  it("o seed grava as cores, o padrão, a cor da sigla e a sigla de cada clube, iguais ao arquivo de dados", async () => {
    await seed(database.db);
    for (const [ticker, badge] of Object.entries(CLUB_BADGES)) {
      const [row] = await database.db.select().from(clubs).where(eq(clubs.ticker, ticker));
      expect(row, ticker).toMatchObject({
        colorPrimary: badge.primary,
        colorSecondary: badge.secondary,
        badgeAbbr: badgeAbbrOf(ticker),
        badgePattern: badge.pattern,
        badgeInk: badge.ink,
        badgeExtra: badge.extra,
      });
    }
  });

  it("clube sem selo aprovado não ganha cores (a tela mostra o neutro)", () => {
    expect(badgeColumns("ZZZ9")).toEqual({});
    expect(badgeColumns("FLA3")).toMatchObject({ badgePattern: "aros-grossos", badgeAbbr: "FLA" });
  });

  it("a migração 0006 atualiza os clubes que já existiam com os mesmos valores do arquivo de dados", () => {
    const sql = readFileSync(`${MIGRATIONS_FOLDER}/0006_selos_dos_clubes.sql`, "utf8");
    for (const [ticker, badge] of Object.entries(CLUB_BADGES)) {
      const update = sql.split("--> statement-breakpoint").find((s) => s.includes(`WHERE "ticker" = '${ticker}'`));
      expect(update, ticker).toBeDefined();
      for (const value of [badge.primary, badge.secondary, badge.pattern, badge.ink, badgeAbbrOf(ticker)]) expect(update, `${ticker} ${value}`).toContain(`'${value}'`);
      expect(update, ticker).toContain(badge.extra === null ? `"badge_extra" = NULL` : `"badge_extra" = '${badge.extra}'`);
    }
  });
});
