import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { bots, positions, seasonClubs, wallets } from "../../src/infra/db/schema/index.js";
import { assertLedgerConsistent, assertSharesConserved } from "../support/invariants.js";
import { closeWindow, TREASURY_SHARES, useEntryApp } from "./support.js";

describe("entrada do bot (EntryService.enterBot)", () => {
  const e = useEntryApp({ clubs: 20 });
  const newBot = async () => (await e.db.insert(bots).values({ profile: "trader", active: true }).returning({ id: bots.id }))[0]!.id;

  it("entrada 15: o bot ganha a carteira índice, de dono bot, sem escolha", async () => {
    const botId = await newBot();
    const { result, created } = await e.service.enterBot(botId);
    expect(created).toBe(true);
    // 20 clubes a R$ 24,00 = R$ 480,00 → N = 145
    expect(result).toMatchObject({ mode: "index", n: 145, sum: 48_000, repeated: false });
    const [wallet] = await e.db.select().from(wallets).where(eq(wallets.botId, botId));
    expect(wallet).toMatchObject({ ownerType: "bot", userId: null, entryMode: "index", cash: result.cash });
    const held = await e.db.select().from(positions).where(eq(positions.walletId, wallet!.id));
    expect(held).toHaveLength(20);
    expect(held.every((p) => p.shares === 145)).toBe(true);
    await assertSharesConserved(e.db, e.world.seasonId);
    await assertLedgerConsistent(e.db, e.world.seasonId);
  });

  it("entrada 15: repetir não emite de novo", async () => {
    const botId = await newBot();
    const first = await e.service.enterBot(botId);
    const totals = async () => (await e.db.select().from(seasonClubs).where(eq(seasonClubs.seasonId, e.world.seasonId))).map((c) => c.totalShares);
    const before = await totals();
    const again = await e.service.enterBot(botId);
    expect(again.created).toBe(false);
    expect(again.result).toEqual({ ...first.result, repeated: true });
    expect(await totals()).toEqual(before);
    const ours = await e.db.select().from(wallets).where(and(eq(wallets.botId, botId), eq(wallets.seasonId, e.world.seasonId)));
    expect(ours).toHaveLength(1);
    expect(before.every((t) => t >= TREASURY_SHARES + 145)).toBe(true);
  });

  it("a mesma janela da pessoa: com a Série A encerrada o bot recebe entry_window_closed", async () => {
    const botId = await newBot();
    await closeWindow(e.db, e.world.seasonId);
    e.clock.set(new Date("2027-12-03T12:00:00Z"));
    await expect(e.service.enterBot(botId)).rejects.toMatchObject({ code: "entry_window_closed" });
  });
});
