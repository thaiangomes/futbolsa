import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { marketMakerStateSchema } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { adminLog, seasons } from "../../src/infra/db/schema/index.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { expectAdminOnly } from "../support/admin-routes.js";
import { createTestApp } from "../support/app.js";
import { bearer, TOKEN_T0, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { listClubs, seedSeason } from "../support/fixtures.js";

// T15 do Plano do livro de ofertas e formador: os percentuais do formador no admin.

describe("percentuais do formador (admin)", () => {
  const database = useTestDatabase(10);
  const clock = new FixedClock(new Date(TOKEN_T0.getTime() + 60_000));
  let app: NestFastifyApplication;
  let admin: TestAccount;
  let seasonId: number;

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    admin = await createAccount(database.db, { role: "admin" });
    const seeded = await seedSeason(database.db);
    seasonId = seeded.seasonId;
    await listClubs(database.db, seasonId, seeded.clubIds, ["FLA3"]);
  });
  afterAll(() => app.close());

  const patch = (payload: object, token = admin.token) => app.inject({ method: "PATCH", url: "/admin/market-maker", headers: bearer(token), payload });
  const lastLog = async () => (await database.db.select().from(adminLog).where(eq(adminLog.action, "market-maker.update")).orderBy(desc(adminLog.id)).limit(1))[0];

  it("os valores em vigor: 0,25% fora de jogo, 0,06% no jogo, mínimos de 10 e 3 e o lote de 20%", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/market-maker", headers: bearer(admin.token) });
    expect(res.statusCode).toBe(200);
    expect(marketMakerStateSchema.parse(res.json())).toEqual({ mmQuantityBp: 25, mmMatchQuantityBp: 6, mmMinSideQty: 10, mmMatchMinSideQty: 3, mmLotBp: 2000 });
  });

  it("livro 34: mudar 0,25% para 1% com motivo grava o valor novo, e o registro do admin guarda antes, depois e motivo", async () => {
    const res = await patch({ mmQuantityBp: 100, reason: "Poucos jogadores: a casa precisa de mais fôlego" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ mmQuantityBp: 100, mmMatchQuantityBp: 6, mmMinSideQty: 10, mmMatchMinSideQty: 3, mmLotBp: 2000 });
    const [season] = await database.db.select().from(seasons).where(eq(seasons.id, seasonId));
    expect(season!.mmQuantityBp).toBe(100);
    const entry = await lastLog();
    expect(entry).toMatchObject({
      actorId: admin.id,
      action: "market-maker.update",
      targetType: "season",
      reason: "Poucos jogadores: a casa precisa de mais fôlego",
      before: { mmQuantityBp: 25, mmMatchQuantityBp: 6, mmMinSideQty: 10, mmMatchMinSideQty: 3, mmLotBp: 2000 },
      after: { mmQuantityBp: 100, mmMatchQuantityBp: 6, mmMinSideQty: 10, mmMatchMinSideQty: 3, mmLotBp: 2000 },
    });
  });

  it("livro 34: sem motivo a mudança é recusada e nada muda", async () => {
    const before = await database.db.select().from(adminLog).where(eq(adminLog.action, "market-maker.update"));
    for (const payload of [{ mmMatchQuantityBp: 10 }, { mmMatchQuantityBp: 10, reason: "" }, { mmMatchQuantityBp: 10, reason: "  " }]) {
      const res = await patch(payload);
      expect(res.statusCode).toBe(400);
    }
    const [season] = await database.db.select().from(seasons).where(eq(seasons.id, seasonId));
    expect(season!.mmMatchQuantityBp).toBe(6);
    expect(await database.db.select().from(adminLog).where(eq(adminLog.action, "market-maker.update"))).toHaveLength(before.length);
  });

  it("recusa valor fora da faixa, sem nenhum campo para mudar e campo desconhecido", async () => {
    expect((await patch({ mmQuantityBp: 10_001, reason: "motivo válido" })).statusCode).toBe(400);
    expect((await patch({ mmMinSideQty: 0, reason: "motivo válido" })).statusCode).toBe(400);
    expect((await patch({ reason: "motivo válido" })).statusCode).toBe(400);
    expect((await patch({ spread: 5, mmQuantityBp: 30, reason: "motivo válido" })).statusCode).toBe(400);
  });

  it("os mínimos por lado mudam juntos com os percentuais, e o resto fica como estava", async () => {
    const res = await patch({ mmMinSideQty: 20, mmMatchMinSideQty: 5, reason: "Jogo pequeno: mínimo maior" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ mmQuantityBp: 100, mmMinSideQty: 20, mmMatchMinSideQty: 5 });
  });

  it("jogador recebe 403 e quem não está logado, 401", async () => {
    await expectAdminOnly(app, database.db, { method: "PATCH", url: "/admin/market-maker", payload: { mmQuantityBp: 50, reason: "teste de acesso" } });
  });

  it("o lote muda antes da abertura do IPO e é recusado depois", async () => {
    expect((await patch({ mmLotBp: 1500, reason: "Lote menor antes do IPO" })).statusCode).toBe(200);
    await database.db.update(seasons).set({ status: "ipo_open" }).where(eq(seasons.id, seasonId));
    const refused = await patch({ mmLotBp: 3000, reason: "Tarde demais para mudar o lote" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("lot_locked");
    const [season] = await database.db.select().from(seasons).where(eq(seasons.id, seasonId));
    expect(season!.mmLotBp).toBe(1500);
    // os percentuais continuam valendo mudar depois da abertura
    expect((await patch({ mmQuantityBp: 50, reason: "Ajuste durante o jogo" })).statusCode).toBe(200);
  });
});
