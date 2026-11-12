import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { publicPlayerSchema } from "@futbolsa/contracts";
import { FixedClock } from "../../src/infra/clock/index.js";
import { withTransaction } from "../../src/infra/db/index.js";
import { portfolioSnapshots, wallets } from "../../src/infra/db/schema/index.js";
import { SnapshotService } from "../../src/modules/portfolio/snapshots/snapshot.service.js";
import { createAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { useTestDatabase } from "../support/db.js";
import { openWallets } from "../support/fixtures.js";
import { AFTER_OPEN, applyMovements, insertPayout, ipoBuy, portfolioSeason, setPrice, type PortfolioSeason } from "./support.js";

// T10: foto mensal e perfil (Carteira e gráficos 30, 31, 32 e 41).

const at = (iso: string) => new Date(iso);

describe("SnapshotService e GET /players/:nickname", () => {
  const database = useTestDatabase(12);
  const clock = new FixedClock(AFTER_OPEN);
  let app: NestFastifyApplication;
  let s: PortfolioSeason;
  let service: SnapshotService;
  let fla: number;
  let pal: number;

  const player = async (enteredAt?: Date) => {
    const account = await createAccount(database.db);
    const [wallet] = await openWallets(database.db, s.seasonId, [{ type: "user", userId: account.id }]);
    if (enteredAt) await database.db.update(wallets).set({ enteredAt }).where(eq(wallets.id, wallet!));
    return { account, wallet: wallet! };
  };
  const profile = async (nickname: string, when: Date) => {
    clock.set(when);
    const res = await app.inject({ method: "GET", url: `/players/${nickname}` });
    clock.set(AFTER_OPEN);
    expect(res.statusCode).toBe(200);
    return { body: res.body, player: publicPlayerSchema.parse(res.json()) };
  };
  const rowOf = async (walletId: number, month: string) =>
    (await database.db.select().from(portfolioSnapshots).where(and(eq(portfolioSnapshots.walletId, walletId), eq(portfolioSnapshots.month, month))))[0];

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock });
    service = app.get(SnapshotService);
    s = await portfolioSeason(database.db);
    fla = s.clubIds.get("FLA3")!;
    pal = s.clubIds.get("PAL3")!;
  });
  afterAll(async () => {
    await app.close();
  });

  it("carteira 30, 31, 32 e 41: 47,5% e 52,5% sem quantidades; em 20/06 ainda a de maio e em 01/07 a de junho; quem entrou em 15/06 só ganha a de junho", async () => {
    const ana = await player();
    await applyMovements(database.db, ana.wallet, at("2027-04-05T13:00:00Z"), ipoBuy(fla, 1000, 4750));
    await setPrice(database.db, s, "FLA3", at("2027-04-06T13:00:00Z"), 4750);
    // R$ 360,00 a receber de um evento fechado: a foto não conta o "a receber" (critério 41)
    await insertPayout(database.db, { seasonId: s.seasonId, clubId: fla }, { key: "pts-41", perShare: 36, closedAt: at("2027-04-20T12:00:00Z"), holdings: [[ana.wallet, 1000]] });
    const late = await player(at("2027-06-15T12:00:00Z"));

    const report = await service.runOnce(at("2027-07-01T12:00:00Z"));
    expect(report.months).toEqual(["2027-04", "2027-05", "2027-06"]);
    expect((await rowOf(ana.wallet, "2027-05"))!.slices).toEqual({ FLA3: 475, cash: 525 });
    // quem entrou em 15/06: nada em abril e maio (não existia), foto só no fim de junho
    expect(await rowOf(late.wallet, "2027-05")).toBeUndefined();
    expect((await rowOf(late.wallet, "2027-06"))!.slices).toEqual({ cash: 1000 });

    const may = await profile(ana.account.nickname, at("2027-06-20T12:00:00Z"));
    expect(may.player.snapshot).toEqual({ month: "2027-05", slices: [{ key: "FLA3", name: "Flamengo", permille: 475 }, { key: "cash", name: null, permille: 525 }] });
    expect((await profile(ana.account.nickname, at("2027-07-01T12:00:00Z"))).player.snapshot!.month).toBe("2027-06");
    // durante o mês corrente nunca aparece o mês corrente
    expect((await profile(ana.account.nickname, at("2027-04-20T12:00:00Z"))).player.snapshot).toBeNull();
    expect((await profile(late.account.nickname, at("2027-06-20T12:00:00Z"))).player.snapshot).toBeNull();
    expect((await profile(late.account.nickname, at("2027-07-01T12:00:00Z"))).player.snapshot!.month).toBe("2027-06");

    // só décimos de ponto percentual por clube: nada de quantidade, preço, valor, dividendo ou a receber
    const text = may.body.toLowerCase();
    for (const word of ["shares", "quantity", "quantidade", "price", "value", "valor", "dividend", "receivable", "cash\":"]) {
      if (word === "cash\":") continue;
      expect(text).not.toContain(word);
    }
  });

  it("gravar de novo não muda uma foto já gravada, e recalcular o mês não a regrava", async () => {
    const bia = await player();
    await applyMovements(database.db, bia.wallet, at("2027-04-05T13:00:00Z"), ipoBuy(pal, 100, 4000));
    await service.runOnce(at("2027-05-02T12:00:00Z"));
    const first = await rowOf(bia.wallet, "2027-04");
    await applyMovements(database.db, bia.wallet, at("2027-04-10T12:00:00Z"), { kind: "reversal", clubId: pal, cashDelta: -1_000_000, reason: "correção" });
    const written = await withTransaction(database.db, (tx) => service.takeSnapshots(tx, s.seasonId, at("2027-05-01T02:59:00Z")));
    expect(written).toBe(0);
    expect(await rowOf(bia.wallet, "2027-04")).toEqual(first);
  });

  it("caixa negativo vira fatia negativa e base zero grava {}", async () => {
    const neg = await player();
    await applyMovements(database.db, neg.wallet, at("2027-04-05T13:00:00Z"), ipoBuy(pal, 1000, 4000));
    await applyMovements(database.db, neg.wallet, at("2027-04-06T12:00:00Z"), { kind: "reversal", clubId: pal, cashDelta: -7_000_000, reason: "correção" });
    const zero = await player();
    await applyMovements(database.db, zero.wallet, at("2027-04-06T12:00:00Z"), { kind: "reversal", clubId: pal, cashDelta: -10_000_000, reason: "correção" });
    await service.runOnce(at("2027-05-02T12:00:00Z"));
    expect((await rowOf(neg.wallet, "2027-04"))!.slices).toEqual({ cash: -333, PAL3: 1333 });
    expect((await rowOf(zero.wallet, "2027-04"))!.slices).toEqual({});
  });

  it("perfil de conta inexistente dá 404 e o perfil sem foto traz snapshot nulo", async () => {
    expect((await app.inject({ method: "GET", url: "/players/ninguem_aqui" })).statusCode).toBe(404);
    const fresh = await player();
    expect((await profile(fresh.account.nickname, at("2027-04-20T12:00:00Z"))).player).toEqual({ nickname: fresh.account.nickname, snapshot: null });
  });
});
