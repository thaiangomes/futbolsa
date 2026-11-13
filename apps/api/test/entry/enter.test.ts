import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { lockClubs, lockSeason, lockWallets, withTransaction } from "../../src/infra/db/index.js";
import { positions, seasonClubs, walletEntries, wallets } from "../../src/infra/db/schema/index.js";
import { assertLedgerConsistent, assertSharesConserved } from "../support/invariants.js";
import { deferred, INITIAL_CASH, sleep, T0 } from "../support/fixtures.js";
import { closeWindow, TREASURY_SHARES, useEntryApp } from "./support.js";


async function walletOf(e: ReturnType<typeof useEntryApp>, userId: string) {
  const [w] = await e.db.select().from(wallets).where(and(eq(wallets.seasonId, e.world.seasonId), eq(wallets.userId, userId)));
  return w;
}
const sharesOf = async (e: ReturnType<typeof useEntryApp>, walletId: number) =>
  e.db.select().from(positions).where(eq(positions.walletId, walletId));
const totalSharesOf = async (e: ReturnType<typeof useEntryApp>) =>
  new Map((await e.db.select().from(seasonClubs).where(eq(seasonClubs.seasonId, e.world.seasonId))).map((r) => [r.clubId, r.totalShares]));

describe("entrada no meio: carteira índice", () => {
  const e = useEntryApp({ clubs: 22 });

  it("entrada 1, 13 e 14: 134 ações de cada, R$ 30.320,00 em caixa e patrimônio de R$ 100.000,00 pelo extrato", async () => {
    // preços de R$ 520,00 no total: sobrescreve o `last_price` de cada clube
    const rows = await e.db.select().from(seasonClubs).where(eq(seasonClubs.seasonId, e.world.seasonId));
    const priceById = new Map<number, number>();
    for (const [i, r] of rows.entries()) {
      priceById.set(r.clubId, i < 20 ? 2400 : 2000);
      await e.db
        .update(seasonClubs)
        .set({ lastPrice: i < 20 ? 2400 : 2000 })
        .where(and(eq(seasonClubs.seasonId, r.seasonId), eq(seasonClubs.clubId, r.clubId)));
    }
    const owner = await e.newOwner();
    const { result, created } = await e.service.enter(owner, "index");
    expect(created).toBe(true);
    expect(result).toMatchObject({ mode: "index", n: 134, sum: 52_000, cash: 3_032_000, stockValue: 6_968_000, repeated: false });
    expect(result.clubs).toHaveLength(22);

    const wallet = (await walletOf(e, (owner as { userId: string }).userId))!;
    expect(wallet).toMatchObject({ cash: 3_032_000, reservedCash: 0, entryMode: "index" });
    expect(wallet.enteredAt).toEqual(T0);
    const held = await sharesOf(e, wallet.id);
    expect(held).toHaveLength(22);
    expect(held.every((p) => p.shares === 134)).toBe(true);
    // patrimônio do extrato no instante da entrada = caixa + ações pelo preço de referência = R$ 100.000,00
    const entries = await e.db.select().from(walletEntries).where(eq(walletEntries.walletId, wallet.id));
    const cash = entries.reduce((a, x) => a + x.cashDelta, 0);
    const stock = entries.reduce((a, x) => a + x.sharesDelta * (x.price ?? 0), 0);
    expect(cash + stock).toBe(INITIAL_CASH);
    expect(entries.map((x) => x.kind).sort()).toEqual(["index_entry", ...Array(21).fill("index_entry"), "initial"].sort());
    expect(entries.every((x) => x.at.getTime() === T0.getTime())).toBe(true);
    // preço médio = referência (critério 5)
    expect(held.every((p) => p.cost === 134 * priceById.get(p.clubId)!)).toBe(true);
  });

  it("entrada 3: cada clube sobe N em total_shares e as ações se conservam", async () => {
    const totals = await totalSharesOf(e);
    expect([...totals.values()].every((t) => t === TREASURY_SHARES + 134)).toBe(true);
    await assertSharesConserved(e.db, e.world.seasonId);
    await assertLedgerConsistent(e.db, e.world.seasonId);
  });

  it("entrada 10: repetir com o mesmo modo devolve o mesmo resultado, sem emitir de novo", async () => {
    const owner = await e.newOwner();
    const first = await e.service.enter(owner, "index");
    const before = await totalSharesOf(e);
    const again = await e.service.enter(owner, "index");
    expect(again.created).toBe(false);
    expect(again.result).toEqual({ ...first.result, repeated: true });
    expect(await totalSharesOf(e)).toEqual(before);
  });

  it("entrada 10: outro modo depois de entrar dá already_entered e nada muda", async () => {
    const owner = await e.newOwner();
    await e.service.enter(owner, "index");
    const before = await totalSharesOf(e);
    await expect(e.service.enter(owner, "cash")).rejects.toMatchObject({ code: "already_entered", status: 409 });
    expect(await totalSharesOf(e)).toEqual(before);
  });

  it("repetição: 10 chamadas iguais ao mesmo tempo dão uma carteira, uma emissão e 9 respostas repeated", async () => {
    const owner = await e.newOwner();
    const before = await totalSharesOf(e);
    const outcomes = await Promise.all(Array.from({ length: 10 }, () => e.service.enter(owner, "index")));
    expect(outcomes.filter((o) => o.created)).toHaveLength(1);
    expect(outcomes.filter((o) => o.result.repeated)).toHaveLength(9);
    const after = await totalSharesOf(e);
    const n = outcomes[0]!.result.n;
    for (const [club, total] of after) expect(total).toBe(before.get(club)! + n);
    expect(await e.db.select().from(wallets).where(eq(wallets.userId, (owner as { userId: string }).userId))).toHaveLength(1);
    await assertSharesConserved(e.db, e.world.seasonId);
  });

  it("duas pessoas ao mesmo tempo: duas emissões e as ações se conservam", async () => {
    const [a, b] = [await e.newOwner(), await e.newOwner()];
    const before = await totalSharesOf(e);
    const [ra, rb] = await Promise.all([e.service.enter(a, "index"), e.service.enter(b, "cash")]);
    const after = await totalSharesOf(e);
    const emitted = ra.result.n; // a carteira índice emite N; o só caixa também (N da tesouraria)
    for (const [club, total] of after) expect(total).toBe(before.get(club)! + emitted * 2);
    expect(rb.result).toMatchObject({ mode: "cash", n: 0, cash: INITIAL_CASH });
    await assertSharesConserved(e.db, e.world.seasonId);
    await assertLedgerConsistent(e.db, e.world.seasonId);
  });

  it("entrada 12: com a Série A encerrada, 409 entry_window_closed, nenhuma carteira e nada emitido", async () => {
    const owner = await e.newOwner();
    const before = await totalSharesOf(e);
    await closeWindow(e.db, e.world.seasonId);
    e.clock.set(new Date("2027-12-03T12:00:00Z"));
    await expect(e.service.enter(owner, "index")).rejects.toMatchObject({ code: "entry_window_closed", status: 409 });
    expect(await walletOf(e, (owner as { userId: string }).userId)).toBeUndefined();
    expect(await totalSharesOf(e)).toEqual(before);
    // quem já entrou continua recebendo a resposta repetida mesmo com a janela fechada
    e.clock.set(T0);
    await e.db.execute(sql`update futbolsa.matches set status = 'scheduled', finished_at = null, home_goals = null, away_goals = null where round = 2`);
  });

  it("D2: mercado todo suspenso → 409 market_suspended com o motivo", async () => {
    const owner = await e.newOwner();
    await e.db.execute(sql`update futbolsa.seasons set suspended_reason = 'preço errado'`);
    await expect(e.service.enter(owner, "index")).rejects.toMatchObject({ code: "market_suspended", status: 409 });
    await e.db.execute(sql`update futbolsa.seasons set suspended_reason = null`);
  });

  it("o IPO ainda liquidando → 409 entry_not_ready; antes do fechamento → entry_not_open", async () => {
    const owner = await e.newOwner();
    await e.db.execute(sql`update futbolsa.seasons set status = 'ipo_open'`);
    await expect(e.service.enter(owner, "index")).rejects.toMatchObject({ code: "entry_not_open", status: 409 });
    await e.db.execute(sql`update futbolsa.seasons set status = 'ipo_closed'`);
    const saved = (await e.db.execute(sql`select * from futbolsa.ipo_results limit 1`)).rows[0] as { club_id: number };
    await e.db.execute(sql`delete from futbolsa.ipo_results where club_id = ${saved.club_id}`);
    await expect(e.service.enter(owner, "index")).rejects.toMatchObject({ code: "entry_not_ready", status: 409 });
    await e.db.execute(sql`update futbolsa.seasons set status = 'trading'`);
  });

  it("conta bloqueada → 403 account_blocked", async () => {
    const owner = await e.newOwner();
    await expect(e.service.enter({ ...owner, status: "blocked" } as typeof owner, "index")).rejects.toMatchObject({ code: "account_blocked", status: 403 });
    await e.db.execute(sql`update futbolsa.users set status = 'blocked' where id = ${(owner as { userId: string }).userId}`);
    await expect(e.service.enter(owner, "index")).rejects.toMatchObject({ code: "account_blocked" });
  });

  it("relógio (P3): o horário vem depois das travas, mesmo se o relógio andou durante a espera", async () => {
    const owner = await e.newOwner();
    const held = deferred();
    const released = deferred();
    // outra transação segura o clube de menor ticker; a entrada espera nele
    const holder = withTransaction(e.db, async (tx) => {
      await lockSeason(tx, e.world.seasonId, "share");
      await lockClubs(tx, e.world.seasonId, [e.world.tickers.slice().sort()[0]!]);
      held.resolve();
      await released.promise;
    });
    await held.promise;
    const entering = e.service.enter(owner, "index");
    await sleep(300);
    const later = new Date(T0.getTime() + 60_000);
    e.clock.set(later);
    released.resolve();
    await holder;
    const { result } = await entering;
    expect(result.enteredAt).toBe(later.toISOString());
    const wallet = (await walletOf(e, (owner as { userId: string }).userId))!;
    expect(wallet.enteredAt).toEqual(later);
    const entries = await e.db.select().from(walletEntries).where(eq(walletEntries.walletId, wallet.id));
    expect(entries.every((x) => x.at.getTime() === later.getTime())).toBe(true);
    e.clock.set(T0);
  });
});

describe("entrada no meio: só caixa", () => {
  const e = useEntryApp({ clubs: 22 });

  it("entrada 2: R$ 100.000,00, nenhuma ação, e a tesouraria sobe N em cada clube", async () => {
    const owner = await e.newOwner();
    const { result } = await e.service.enter(owner, "cash");
    expect(result).toMatchObject({ mode: "cash", n: 0, cash: INITIAL_CASH, stockValue: 0, clubs: [] });
    const wallet = (await walletOf(e, (owner as { userId: string }).userId))!;
    expect(wallet).toMatchObject({ cash: INITIAL_CASH, entryMode: "cash" });
    expect(await sharesOf(e, wallet.id)).toHaveLength(0);
    // 22 clubes a R$ 24,00 → N = ⌊70.000 ÷ 528⌋ = 132
    const treasury = await sharesOf(e, e.world.treasuryId);
    expect(treasury).toHaveLength(22);
    expect(treasury.every((p) => p.shares === TREASURY_SHARES + 132)).toBe(true);
    const lines = await e.db.select().from(walletEntries).where(and(eq(walletEntries.walletId, e.world.treasuryId), eq(walletEntries.kind, "index_entry")));
    expect(lines).toHaveLength(22);
    expect(lines.every((l) => l.cashDelta === 0 && l.sharesDelta === 132 && l.refType === "entry" && l.refId === String(wallet.id))).toBe(true);
    await assertSharesConserved(e.db, e.world.seasonId);
    await assertLedgerConsistent(e.db, e.world.seasonId);
  });

  it("repetir o só caixa devolve o mesmo resultado, sem emitir de novo", async () => {
    const owner = await e.newOwner();
    const first = await e.service.enter(owner, "cash");
    const again = await e.service.enter(owner, "cash");
    expect(again.created).toBe(false);
    expect(again.result).toEqual({ ...first.result, repeated: true });
    const treasury = await sharesOf(e, e.world.treasuryId);
    expect(treasury.every((p) => p.shares === TREASURY_SHARES + 132 * 2)).toBe(true);
  });
});

describe("entrada no meio: preços de referência", () => {
  const e = useEntryApp({ clubs: 4, prices: { FLA3: 4400, PAL3: 4000, SAO3: 5000, COR3: 50 } });

  it("entrada 5, 6 e 7: último negócio, preço do IPO sem negócio e o piso de R$ 0,50 entram na soma", async () => {
    // PAL3 sem negócio: usa o preço do IPO (R$ 40,00); SAO3 no preço do IPO diferente do último negócio
    await e.db.update(seasonClubs).set({ lastPrice: null, lastTradeAt: null }).where(eq(seasonClubs.clubId, e.world.clubIds.get("PAL3")!));
    await e.db.update(seasonClubs).set({ ipoPrice: 4800 }).where(eq(seasonClubs.clubId, e.world.clubIds.get("SAO3")!));
    const owner = await e.newOwner();
    const { result } = await e.service.enter(owner, "index");
    const byTicker = Object.fromEntries(result.clubs.map((c) => [c.ticker, c.price]));
    expect(byTicker).toEqual({ COR3: 50, FLA3: 4400, PAL3: 4000, SAO3: 5000 });
    // soma R$ 134,50 → ⌊70.000 ÷ 134,50⌋ = 520
    expect(result).toMatchObject({ n: 520, sum: 13_450 });
    const wallet = (await walletOf(e, (owner as { userId: string }).userId))!;
    const fla = (await sharesOf(e, wallet.id)).find((p) => p.clubId === e.world.clubIds.get("FLA3"))!;
    expect(fla.shares).toBe(520);
    expect(fla.cost).toBe(520 * 4400); // preço médio = R$ 44,00 (critério 5)
    const cor = (await sharesOf(e, wallet.id)).find((p) => p.clubId === e.world.clubIds.get("COR3"))!;
    expect(cor.shares).toBe(520);
  });

  it("entrada 8: a confirmação vale o preço do momento, não o da prévia", async () => {
    // um negócio mudou o preço do FLA3 de R$ 44,00 para R$ 45,00 entre a prévia e a confirmação
    await e.db.update(seasonClubs).set({ lastPrice: 4500 }).where(eq(seasonClubs.clubId, e.world.clubIds.get("FLA3")!));
    const owner = await e.newOwner();
    const { result } = await e.service.enter(owner, "index");
    expect(result.clubs.find((c) => c.ticker === "FLA3")!.price).toBe(4500);
    expect(result.sum).toBe(13_550);
    expect(result.n).toBe(Math.floor(7_000_000 / 13_550));
    expect(result.cash).toBe(INITIAL_CASH - result.n * 13_550);
  });
});

describe("entrada no meio: soma acima de R$ 70.000,00", () => {
  const e = useEntryApp({ clubs: 3, prices: { FLA3: 4_000_000, PAL3: 3_000_100, SAO3: 100 } });

  it("entrada 16: R$ 100.000,00 em caixa, nenhuma ação, total_shares igual e a tesouraria não é travada", async () => {
    const before = await totalSharesOf(e);
    const owner = await e.newOwner();
    // a tesouraria presa por outra transação não atrapalha: a entrada com n = 0 nem a trava
    const held = deferred();
    const released = deferred();
    const holder = withTransaction(e.db, async (tx) => {
      await lockWallets(tx, [e.world.treasuryId]);
      held.resolve();
      await released.promise;
    });
    await held.promise;
    const { result } = await e.service.enter(owner, "index");
    released.resolve();
    await holder;
    expect(result).toMatchObject({ n: 0, cash: INITIAL_CASH, stockValue: 0, clubs: [] });
    expect(await totalSharesOf(e)).toEqual(before);
    const wallet = (await walletOf(e, (owner as { userId: string }).userId))!;
    expect(await sharesOf(e, wallet.id)).toHaveLength(0);
    const again = await e.service.enter(owner, "index");
    expect(again.result).toEqual({ ...result, repeated: true });
    await assertSharesConserved(e.db, e.world.seasonId);
  });

  it("o modo só caixa com n = 0 também não emite nada", async () => {
    const before = await totalSharesOf(e);
    const { result } = await e.service.enter(await e.newOwner(), "cash");
    expect(result).toMatchObject({ n: 0, cash: INITIAL_CASH });
    expect(await totalSharesOf(e)).toEqual(before);
    const lines = await e.db.select().from(walletEntries).where(eq(walletEntries.kind, "index_entry"));
    expect(lines).toHaveLength(0);
  });
});
