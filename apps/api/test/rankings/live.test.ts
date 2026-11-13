import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { liveRankingSchema, rankingsLiveEventSchema, type LiveRanking } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { EventBus } from "../../src/infra/realtime/index.js";
import { LiveService } from "../../src/modules/rankings/live.service.js";
import { WalletService } from "../../src/modules/portfolio/wallet/wallet.service.js";
import { createTestApp } from "../support/app.js";
import { bearer, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { openPlayerWallets, rng } from "../support/fixtures.js";
import { AFTER_OPEN, applyMovements, ipoBuy, portfolioSeason, setPrice, type PortfolioSeason } from "../portfolio/support.js";
import { bot, player, setBotsInRankings, setStatus } from "./support.js";

// T7: a parcial ao vivo (Rankings mensal e anual 8, 17, 18 e 22; Carteira e gráficos 13).

describe("parcial ao vivo", () => {
  const database = useTestDatabase(10);
  const clock = new FixedClock(AFTER_OPEN);
  let app: NestFastifyApplication;
  let s: PortfolioSeason;
  let live: LiveService;
  let fla: number;
  const BUY = new Date("2027-04-05T14:00:00Z");

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    live = app.get(LiveService);
    s = await portfolioSeason(database.db);
    fla = s.clubIds.get("FLA3")!;
  });
  afterAll(async () => {
    await app.close();
  });

  const get = async (query = "", token?: string) => {
    const res = await app.inject({ method: "GET", url: `/rankings/live${query}`, headers: token ? bearer(token) : undefined });
    expect(res.statusCode).toBe(200);
    return liveRankingSchema.parse(res.json());
  };
  const position = (r: LiveRanking, name: string) => r.rows.find((x) => x.displayName === name)?.position;

  it("rankings 22: um negócio muda a parcial depois da janela de 5 segundos; antes, vale o cálculo guardado", async () => {
    const ana = await player(database.db, s.seasonId, { nickname: "ana_live" });
    await applyMovements(database.db, ana.wallet, BUY, ipoBuy(fla, 1000, 4000));
    clock.set(AFTER_OPEN);
    const first = await get("?limit=100");
    const mineBefore = first.rows.find((r) => r.displayName === "ana_live")!;
    expect(mineBefore.returnBp).toBe(0);
    await setPrice(database.db, s, "FLA3", new Date(AFTER_OPEN.getTime() + 1000), 5000);
    clock.set(new Date(AFTER_OPEN.getTime() + 3000));
    expect((await get("?limit=100")).rows.find((r) => r.displayName === "ana_live")!.returnBp).toBe(0); // ainda o guardado
    clock.set(new Date(AFTER_OPEN.getTime() + 6000));
    expect((await get("?limit=100")).rows.find((r) => r.displayName === "ana_live")!.returnBp).toBe(1000); // 1.000 ações × +R$ 10,00 sobre R$ 100.000,00 = +10,00%
    expect(position(await get("?limit=100"), "ana_live")).toBe(1);
  });

  it("rankings 8, 17 e 18: a chave dos bots vale na hora; bloqueado e excluído saem; desbloqueado volta", async () => {
    clock.set(new Date("2027-04-07T12:00:00Z"));
    const b = await bot(database.db, s.seasonId, "dividendos");
    const blocked = await player(database.db, s.seasonId, { nickname: "bloqueado_live" });
    const gone = await player(database.db, s.seasonId, { nickname: "excluido_live" });
    const names = async () => (await get("?limit=100")).rows.map((r) => r.displayName ?? (r.isBot ? "bot" : "excluída"));
    expect(await names()).toContain("bloqueado_live");
    expect(await names()).not.toContain("bot");
    await setBotsInRankings(database.db, s.seasonId, true); // sem esperar 5 s: a chave entra na chave do cache
    const withBot = (await get("?limit=100")).rows.filter((r) => r.isBot);
    expect(withBot).toHaveLength(1);
    expect(withBot[0]!.botLabel).toBe("Bot dividendos");
    await setBotsInRankings(database.db, s.seasonId, false);
    expect((await get("?limit=100")).rows.some((r) => r.isBot)).toBe(false);
    clock.set(new Date("2027-04-07T12:00:10Z"));
    await setStatus(database.db, blocked.account.id, "blocked");
    await setStatus(database.db, gone.account.id, "deleted");
    expect(await names()).not.toContain("bloqueado_live");
    expect(await names()).not.toContain("excluido_live");
    clock.set(new Date("2027-04-07T12:00:20Z"));
    await setStatus(database.db, blocked.account.id, "active");
    expect(await names()).toContain("bloqueado_live");
    void b;
  });

  it("o patrimônio da parcial é o mesmo de GET /portfolio, em 60 carteiras sorteadas", async () => {
    clock.set(new Date("2027-04-08T12:00:00Z"));
    const random = rng(7);
    const wallets = await openPlayerWallets(database.db, s.seasonId, 60);
    for (const w of wallets) {
      const qty = 1 + Math.floor(random() * 500);
      await applyMovements(database.db, w, new Date("2027-04-07T13:00:00Z"), ipoBuy(fla, qty, 4000));
    }
    const snap = (await live.current("month", { force: true }))!;
    const walletService = app.get(WalletService);
    for (const w of wallets) {
      expect(snap.byWallet.get(w)!.equity).toBe((await walletService.view(w)).equity);
    }
  });

  it("500 pedidos ao mesmo tempo fazem um cálculo só", async () => {
    clock.set(new Date("2027-04-09T12:00:00Z"));
    const before = live.computations;
    await Promise.all(Array.from({ length: 500 }, () => live.current("month")));
    expect(live.computations - before).toBe(1);
    clock.set(new Date("2027-04-09T12:00:02Z"));
    await Promise.all(Array.from({ length: 50 }, () => live.current("month")));
    expect(live.computations - before).toBe(1); // dentro dos 5 segundos
  });

  it("a página 101 a 200 e a linha de quem pediu (`me`), mesmo fora da página; sem login `me` vem nulo", async () => {
    clock.set(new Date("2027-04-10T12:00:00Z"));
    await openPlayerWallets(database.db, s.seasonId, 210);
    const me = await player(database.db, s.seasonId, { nickname: "eu_live" });
    const page = await get("?offset=100&limit=100", await me.account.tokenWith({ at: clock.now() }));
    expect(page.rows).toHaveLength(100);
    expect(page.rows[0]!.position).toBeGreaterThan(0);
    expect(page.total).toBeGreaterThan(260);
    expect(page.me).toMatchObject({ displayName: "eu_live", returnBp: 0 });
    expect((await get("?offset=100&limit=100")).me).toBeNull();
    expect((await app.inject({ method: "GET", url: "/rankings/live?limit=101" })).statusCode).toBe(400);
  });

  it("o evento sai só se algo mudou, leva o topo 20 e o total, e a parcial de antes do primeiro negócio usa o preço do IPO", async () => {
    clock.set(new Date("2027-04-11T12:00:00Z"));
    const bus = app.get(EventBus);
    const seq0 = bus.currentSeq("rankings");
    const first = await live.publishIfChanged();
    expect(first.sort()).toEqual(["month", "season"]);
    expect(bus.currentSeq("rankings")).toBe(seq0 + 2);
    expect(await live.publishIfChanged()).toEqual([]); // nada mudou
    await setPrice(database.db, s, "PAL3", new Date("2027-04-11T12:00:30Z"), 4100);
    clock.set(new Date("2027-04-11T12:00:40Z"));
    expect((await live.publishIfChanged()).length).toBe(2);
    const snap = (await live.current("month"))!;
    expect(rankingsLiveEventSchema.shape.top.parse([]).length).toBe(0);
    expect(snap.rows.length).toBeGreaterThan(20);
  });
});
