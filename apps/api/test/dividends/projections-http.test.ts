import "reflect-metadata";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectionListSchema } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { createAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { bearer, TOKEN_T0, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { listClubs, seedSeason } from "../support/fixtures.js";

// Livro de ofertas, critérios 54 a 56: as projeções privadas do jogador por clube.

describe("GET /me/projections e PUT /me/projections/:ticker (critérios 54 a 56)", () => {
  const database = useTestDatabase(10);
  const clock = new FixedClock(new Date(TOKEN_T0.getTime() + 60_000));
  let app: NestFastifyApplication;

  const put = (token: string, ticker: string, payload: unknown) =>
    app.inject({ method: "PUT", url: `/me/projections/${ticker}`, headers: bearer(token), payload: payload as object });
  const list = async (token: string) => projectionListSchema.parse((await app.inject({ method: "GET", url: "/me/projections", headers: bearer(token) })).json());
  const bet = { points: 68, position: 3, cups: { "copa-do-brasil": "quartas", libertadores: "quartas" } };

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    const { seasonId, clubIds } = await seedSeason(database.db);
    await listClubs(database.db, seasonId, clubIds, ["FLA3", "PAL3"], 3000);
  });
  afterAll(() => app?.close());

  it("livro 54: salva as premissas, lê de volta e salvar de novo troca a anterior (uma por clube)", async () => {
    const ana = await createAccount(database.db);
    expect((await list(ana.token)).projections).toEqual([]);
    const res = await put(ana.token, "FLA3", bet);
    expect(res.statusCode).toBe(200);
    expect((await list(ana.token)).projections).toMatchObject([{ ticker: "FLA3", ...bet }]);
    await put(ana.token, "FLA3", { ...bet, points: 70, position: 2 });
    await put(ana.token, "PAL3", { points: 50, position: 8, cups: {} });
    const all = (await list(ana.token)).projections;
    expect(all.map((p) => [p.ticker, p.points, p.position])).toEqual([["FLA3", 70, 2], ["PAL3", 50, 8]]);
  });

  it("livro 56: cada jogador só vê a própria projeção; sem login dá 401", async () => {
    const ana = await createAccount(database.db);
    const bruno = await createAccount(database.db);
    await put(ana.token, "FLA3", bet);
    expect((await list(bruno.token)).projections).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/me/projections" })).statusCode).toBe(401);
    expect((await app.inject({ method: "PUT", url: "/me/projections/FLA3", payload: bet })).statusCode).toBe(401);
  });

  it("livro 56: pontos fora de 0 a 114, colocação fora de 1 a 20 e clube não listado são recusados e a projeção anterior continua", async () => {
    const carla = await createAccount(database.db);
    await put(carla.token, "FLA3", bet);
    for (const bad of [{ ...bet, points: 115 }, { ...bet, points: -1 }, { ...bet, position: 0 }, { ...bet, position: 21 }, { ...bet, points: 1.5 }]) {
      expect((await put(carla.token, "FLA3", bad)).statusCode).toBe(400);
    }
    expect((await put(carla.token, "COR3", bet)).statusCode).toBe(404);
    expect((await list(carla.token)).projections).toMatchObject([{ ticker: "FLA3", points: 68, position: 3 }]);
  });
});
