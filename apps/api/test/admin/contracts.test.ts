import "reflect-metadata";
import { describe, expect, it } from "vitest";
import {
  adminLogQuerySchema,
  adminReasonSchema,
  createMatchBodySchema,
  patchMatchBodySchema,
  patchSeasonBodySchema,
  patchStandingsBodySchema,
  putSeasonClubsBodySchema,
  runImportBodySchema,
  suspendBodySchema,
} from "@futbolsa/contracts";
import { AdminLogModule } from "../../src/modules/admin/log/index.js";
import { AdminModule } from "../../src/modules/admin/admin.module.js";
import { ResultsModule } from "../../src/modules/admin/results/results.module.js";
import { SeasonsModule } from "../../src/modules/admin/seasons/seasons.module.js";
import { StandingsModule } from "../../src/modules/admin/standings/standings.module.js";
import { SuspensionModule } from "../../src/modules/admin/suspension/suspension.module.js";

describe("esqueleto do admin", () => {
  it("o AdminModule já registra as cinco subpastas, para as pistas não brigarem no mesmo arquivo", () => {
    const imports = Reflect.getMetadata("imports", AdminModule) as unknown[];
    expect(imports).toEqual(
      expect.arrayContaining([AdminLogModule, ResultsModule, StandingsModule, SeasonsModule, SuspensionModule]),
    );
  });
});

describe("contratos do admin", () => {
  it("admin 33: o motivo vem sem espaços nas pontas, com 3 a 500 caracteres", () => {
    expect(adminReasonSchema.parse("  placar errado  ")).toBe("placar errado");
    expect(adminReasonSchema.safeParse("ab").success).toBe(false);
    expect(adminReasonSchema.safeParse("   ").success).toBe(false);
    expect(adminReasonSchema.safeParse("x".repeat(501)).success).toBe(false);
  });

  it("admin 33: editar jogo sem motivo é recusado, em todas as rotas de edição", () => {
    const base = { kickoff: "2027-05-01T21:00:00Z" };
    expect(patchMatchBodySchema.safeParse(base).success).toBe(false);
    expect(patchMatchBodySchema.safeParse({ ...base, reason: "data mudou" }).success).toBe(true);
    expect(
      createMatchBodySchema.safeParse({
        competition: "sulamericana",
        phase: "oitavas",
        homeClubId: 1,
        awayClubId: 2,
        kickoff: "2027-05-01T21:00:00Z",
      }).success,
    ).toBe(false);
    expect(patchStandingsBodySchema.safeParse({ order: [1, 2, 3] }).success).toBe(false);
    expect(suspendBodySchema.safeParse({ ticker: "FLA3" }).success).toBe(false);
    expect(suspendBodySchema.safeParse({ ticker: "FLA3", reason: "estádio interditado" }).success).toBe(true);
    expect(suspendBodySchema.safeParse({ reason: "problema na fonte dos placares" }).success).toBe(true);
  });

  it("o cadastro de jogo pede rodada ou fase, nunca as duas, e clubes diferentes", () => {
    const ok = {
      competition: "brasileirao-a",
      round: 3,
      homeClubId: 1,
      awayClubId: 2,
      kickoff: "2027-05-01T21:00:00-03:00",
      reason: "a fonte não trouxe",
    };
    expect(createMatchBodySchema.safeParse(ok).success).toBe(true);
    expect(createMatchBodySchema.safeParse({ ...ok, phase: "oitavas" }).success).toBe(false);
    expect(createMatchBodySchema.safeParse({ ...ok, round: undefined }).success).toBe(false);
    expect(createMatchBodySchema.safeParse({ ...ok, awayClubId: 1 }).success).toBe(false);
    expect(createMatchBodySchema.safeParse({ ...ok, competition: "sul-americana" }).success).toBe(false);
  });

  it("placar negativo, fracionário ou fora de uma data válida é recusado", () => {
    const reason = "correção";
    expect(patchMatchBodySchema.safeParse({ homeGoals: -1, reason }).success).toBe(false);
    expect(patchMatchBodySchema.safeParse({ homeGoals: 1.5, reason }).success).toBe(false);
    expect(patchMatchBodySchema.safeParse({ kickoff: "amanhã", reason }).success).toBe(false);
    expect(patchMatchBodySchema.safeParse({ homeGoals: 2, awayGoals: 1, status: "finished", reason }).success).toBe(true);
  });

  it("a temporada: a oferta é positiva e os clubes são pelo menos 20", () => {
    expect(patchSeasonBodySchema.safeParse({ offerSize: 0 }).success).toBe(false);
    expect(patchSeasonBodySchema.safeParse({}).success).toBe(false);
    expect(patchSeasonBodySchema.safeParse({ offerSize: 1000 }).success).toBe(true);
    const club = (i: number) => ({ clubId: i, division: "A", prevPlacement: i });
    expect(putSeasonClubsBodySchema.safeParse({ clubs: Array.from({ length: 19 }, (_, i) => club(i + 1)) }).success).toBe(false);
    expect(putSeasonClubsBodySchema.safeParse({ clubs: Array.from({ length: 20 }, (_, i) => club(i + 1)) }).success).toBe(true);
    expect(putSeasonClubsBodySchema.safeParse({ clubs: [{ clubId: 1, division: "A", prevPlacement: 25 }] }).success).toBe(false);
  });

  it("o registro: página e filtros com valores padrão, e o limite de 100 por página", () => {
    expect(adminLogQuerySchema.parse({})).toEqual({ page: 1, pageSize: 50 });
    expect(adminLogQuerySchema.parse({ page: "2", pageSize: "10", action: "match.update" })).toEqual({
      page: 2,
      pageSize: 10,
      action: "match.update",
    });
    expect(adminLogQuerySchema.safeParse({ pageSize: "101" }).success).toBe(false);
    expect(adminLogQuerySchema.safeParse({ actorId: "não-é-uuid" }).success).toBe(false);
  });

  it("a importação na hora aceita competição e tipo, ou nada", () => {
    expect(runImportBodySchema.safeParse({}).success).toBe(true);
    expect(runImportBodySchema.safeParse({ competition: "brasileirao-b", kind: "scores" }).success).toBe(true);
    expect(runImportBodySchema.safeParse({ kind: "tudo" }).success).toBe(false);
  });
});
