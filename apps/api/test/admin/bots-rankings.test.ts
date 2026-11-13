import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { liveRankingSchema, seasonViewSchema } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { adminLog, seasons } from "../../src/infra/db/schema/index.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { bearer, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { AFTER_OPEN, portfolioSeason, type PortfolioSeason } from "../portfolio/support.js";
import { bot, player } from "../rankings/support.js";

// F14, T8: a chave "bots nos rankings" pela rota do admin e o efeito, junto com a F13, na parcial ao vivo
// (Admin 25, 26, 30 e 35; Rankings mensal e anual 6, 7 e 8).

describe("chave dos bots nos rankings e efeito de bloquear e excluir", () => {
  const database = useTestDatabase(10);
  const clock = new FixedClock(AFTER_OPEN);
  let app: NestFastifyApplication;
  let s: PortfolioSeason;
  let admin: TestAccount;

  const auth = async (a: TestAccount) => bearer(await a.tokenWith({ at: clock.now() }));
  const tick = (seconds = 10) => clock.set(new Date(clock.now().getTime() + seconds * 1000));
  const asAdmin = async (method: "PATCH" | "POST" | "DELETE", url: string, payload: object) =>
    app.inject({ method, url, payload, headers: await auth(admin) });
  const live = async () => {
    tick();
    const res = await app.inject({ method: "GET", url: "/rankings/live?limit=100" });
    return liveRankingSchema.parse(res.json());
  };
  const names = async () => (await live()).rows.map((r) => r.displayName ?? (r.isBot ? "bot" : "excluída"));

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    s = await portfolioSeason(database.db);
    admin = await createAccount(database.db, { role: "admin" });
  });
  afterAll(() => app.close());

  it("admin 35: ligada a chave, os bots aparecem na parcial marcados como bot; desligada, somem na hora; o registro guarda a mudança", async () => {
    await bot(database.db, s.seasonId, "dividendos");
    expect(await names()).not.toContain("bot");
    const on = await asAdmin("PATCH", `/admin/seasons/${s.seasonId}`, { botsInRankings: true });
    expect(on.statusCode).toBe(200);
    seasonViewSchema.parse(on.json());
    const rows = (await live()).rows.filter((r) => r.isBot);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.botLabel).toBe("Bot dividendos");
    expect((await asAdmin("PATCH", `/admin/seasons/${s.seasonId}`, { botsInRankings: false, reason: "voltando ao normal" })).statusCode).toBe(200);
    expect((await live()).rows.some((r) => r.isBot)).toBe(false);
    const logs = await database.db.select().from(adminLog).where(eq(adminLog.action, "season.bots_in_rankings"));
    expect(logs.map((l) => l.after)).toEqual([{ botsInRankings: true }, { botsInRankings: false }]);
    expect(logs[1]!.reason).toBe("voltando ao normal");
  });

  it("a chave não vai junto de outros campos e a temporada encerrada recusa", async () => {
    const mixed = await asAdmin("PATCH", `/admin/seasons/${s.seasonId}`, { botsInRankings: true, offerSize: 1000 });
    expect(mixed.statusCode).toBe(400);
    await database.db.update(seasons).set({ status: "closed" }).where(eq(seasons.id, s.seasonId));
    const closed = await asAdmin("PATCH", `/admin/seasons/${s.seasonId}`, { botsInRankings: true });
    expect(closed.statusCode).toBe(409);
    expect(closed.json().code).toBe("season_closed");
    await database.db.update(seasons).set({ status: "trading" }).where(eq(seasons.id, s.seasonId));
  });

  it("admin 25 e 26: o bloqueado some da parcial e volta ao ser desbloqueado; o excluído some", async () => {
    const blocked = await player(database.db, s.seasonId, { nickname: "bloq_rank" });
    const gone = await player(database.db, s.seasonId, { nickname: "excl_rank" });
    expect(await names()).toContain("bloq_rank");
    expect((await asAdmin("POST", `/admin/players/${blocked.account.id}/block`, { reason: "teste do ranking" })).statusCode).toBe(200);
    expect((await asAdmin("DELETE", `/admin/players/${gone.account.id}`, { confirmNickname: "excl_rank", reason: "pedido do titular" })).statusCode).toBe(202);
    const after = await names();
    expect(after).not.toContain("bloq_rank");
    expect(after).not.toContain("excl_rank");
    expect((await asAdmin("POST", `/admin/players/${blocked.account.id}/unblock`, { reason: "engano" })).statusCode).toBe(200);
    expect(await names()).toContain("bloq_rank");
  });
});
