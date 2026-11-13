import "reflect-metadata";
import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { FixedClock } from "../../src/infra/clock/index.js";
import { lockClubs, lockSeason, withTransaction } from "../../src/infra/db/index.js";
import { ipoResults, seasons, wallets } from "../../src/infra/db/schema/index.js";
import { readAvailability, seasonGate, type EntryOwner } from "../../src/modules/entry/availability.js";
import { EntryPreviewService } from "../../src/modules/entry/preview.service.js";
import { createAccount } from "../support/accounts.js";
import { useTestDatabase } from "../support/db.js";
import { openWallets, T0 } from "../support/fixtures.js";
import { closeWindow, entryWorld, reopenWindow, type EntryWorld } from "./support.js";

describe("seasonGate: o estado da temporada (puro)", () => {
  it.each([
    ["preparing", false, null, "not_open_yet"],
    ["ipo_open", false, null, "not_open_yet"],
    ["ipo_closed", false, null, "settling"],
    ["ipo_closed", true, null, null],
    ["trading", true, null, null],
    ["trading", true, "preço errado", "market_suspended"],
    ["ipo_closed", true, "resultado em dúvida", "market_suspended"],
    ["trading_ended", true, null, "window_closed"],
    ["closed", true, null, "window_closed"],
  ])("%s, liquidado=%s, suspensão=%s → %s", (status, settled, suspendedReason, expected) => {
    expect(seasonGate({ status, suspendedReason }, settled)).toBe(expected);
  });
});

describe("disponibilidade e prévia da entrada", () => {
  const database = useTestDatabase(10);
  const clock = new FixedClock(T0);
  let world: EntryWorld;
  let owner: EntryOwner;
  let preview: EntryPreviewService;

  beforeAll(async () => {
    world = await entryWorld(database.db, { clubs: 22 });
    const account = await createAccount(database.db, { nickname: "novato_prev" });
    owner = { type: "user", userId: account.id, status: "active" };
    preview = new EntryPreviewService(database.db, clock);
  });

  const setSeason = (values: Partial<typeof seasons.$inferInsert>) =>
    database.db.update(seasons).set(values).where(eq(seasons.id, world.seasonId));

  it("entrada 9: sem carteira a prévia está aberta e a carteira índice vem marcada", async () => {
    await setSeason({ status: "trading", suspendedReason: null });
    const p = await preview.preview(owner);
    expect(p.availability).toBe("open");
    expect(p.defaultMode).toBe("index");
    // 22 clubes a R$ 24,00 = R$ 528,00 → ⌊70.000 ÷ 528⌋ = 132
    expect(p.quote).toMatchObject({ n: 132, sum: 52_800, cash: 10_000_000 - 132 * 52_800, clubCount: 22 });
    expect(p.quote!.clubs).toHaveLength(22);
    expect(p.quote!.clubs[0]).toMatchObject({ price: 2400, shares: 132 });
  });

  it("a prévia não trava nada: roda com um clube travado por outra transação", async () => {
    let preview2: Awaited<ReturnType<typeof preview.preview>> | undefined;
    await withTransaction(database.db, async (tx) => {
      await lockSeason(tx, world.seasonId, "update");
      await lockClubs(tx, world.seasonId, world.tickers);
      preview2 = await preview.preview(owner);
    });
    expect(preview2!.availability).toBe("open");
  });

  it("ipo_closed com o IPO ainda liquidando: settling, sem prévia", async () => {
    await setSeason({ status: "ipo_closed" });
    const saved = await database.db.select().from(ipoResults).where(eq(ipoResults.seasonId, world.seasonId));
    await database.db.delete(ipoResults).where(eq(ipoResults.clubId, saved[0]!.clubId));
    const p = await preview.preview(owner);
    expect(p).toMatchObject({ availability: "settling" });
    expect(p.quote).toBeUndefined();
    await database.db.insert(ipoResults).values(saved[0]!);
    expect((await preview.preview(owner)).availability).toBe("open");
    await setSeason({ status: "trading" });
  });

  it("antes do IPO fechar: not_open_yet", async () => {
    await setSeason({ status: "ipo_open" });
    expect((await preview.preview(owner)).availability).toBe("not_open_yet");
    await setSeason({ status: "trading" });
  });

  it("entrada 12: com a Série A encerrada a janela está fechada, e reabre se o jogo volta", async () => {
    await closeWindow(database.db, world.seasonId);
    clock.set(new Date("2027-12-03T12:00:00Z"));
    const p = await preview.preview(owner);
    expect(p.availability).toBe("window_closed");
    expect(p.message).toContain("IPO do ano seguinte");
    expect(p.quote).toBeUndefined();
    await reopenWindow(database.db, world.seasonId);
    expect((await preview.preview(owner)).availability).toBe("open");
    clock.set(T0);
  });

  it("trading_ended e closed: janela fechada", async () => {
    await setSeason({ status: "trading_ended" });
    expect((await preview.preview(owner)).availability).toBe("window_closed");
    await setSeason({ status: "closed" });
    expect(await readAvailability(database.db, owner, clock.now())).toMatchObject({ availability: "not_open_yet" });
    await setSeason({ status: "trading" });
  });

  it("D2: mercado todo suspenso bloqueia com o motivo; clube suspenso sozinho não", async () => {
    await setSeason({ suspendedReason: "preço errado no FLA3" });
    const p = await preview.preview(owner);
    expect(p.availability).toBe("market_suspended");
    expect(p.message).toContain("preço errado no FLA3");
    await setSeason({ suspendedReason: null });
    expect((await preview.preview(owner)).availability).toBe("open");
  });

  it("conta bloqueada recebe 403 account_blocked", async () => {
    await expect(preview.preview({ ...owner, status: "blocked" } as EntryOwner)).rejects.toMatchObject({
      code: "account_blocked",
      status: 403,
    });
  });

  it("já tem carteira: already_entered com o modo; carteira do IPO sem modo", async () => {
    const ipoAccount = await createAccount(database.db, { nickname: "do_ipo" });
    const [walletId] = await openWallets(database.db, world.seasonId, [{ type: "user", userId: ipoAccount.id }]);
    const ipoOwner: EntryOwner = { type: "user", userId: ipoAccount.id, status: "active" };
    expect(await preview.preview(ipoOwner)).toEqual({ availability: "already_entered", message: expect.any(String) });
    await database.db.update(wallets).set({ entryMode: "cash" }).where(eq(wallets.id, walletId!));
    expect(await preview.preview(ipoOwner)).toMatchObject({ availability: "already_entered", mode: "cash" });
  });

  it("sem negócio, o preço de referência é o do IPO (entrada 6)", async () => {
    await database.db.execute(
      sql`update futbolsa.season_clubs set last_price = null, last_trade_at = null, ipo_price = 5000 where season_id = ${world.seasonId}`,
    );
    const p = await preview.preview(owner);
    expect(p.quote!.clubs.every((c) => c.price === 5000)).toBe(true);
    await database.db.execute(
      sql`update futbolsa.season_clubs set last_price = 2400, last_trade_at = ${T0.toISOString()}::timestamptz, ipo_price = 2400 where season_id = ${world.seasonId}`,
    );
  });

  it("sem nenhuma temporada: not_open_yet", async () => {
    await database.db.execute(sql`update futbolsa.seasons set status = 'closed'`);
    expect((await preview.preview(owner)).availability).toBe("not_open_yet");
    await setSeason({ status: "trading" });
  });
});
