import { beforeAll, describe, expect, it } from "vitest";
import { baseOf, closeAtOfMonth, previousMonthKey } from "../../src/modules/rankings/base.js";
import { buildRanking } from "../../src/modules/rankings/build-ranking.js";
import { identities, participants } from "../../src/modules/rankings/participants.js";
import { currentRowsOf, writeSnapshot } from "../../src/modules/rankings/snapshots.js";
import { useTestDatabase } from "../support/db.js";
import { openWallets } from "../support/fixtures.js";
import { BASE, at, bot, br, inTx, player, portfolioSeason, setCash, setStatus, type PortfolioSeason } from "./support.js";

// T4: quem aparece e qual é a base (Rankings mensal e anual, critérios 3, 4, 6, 7, 16, 17 e 18).

describe("participants", () => {
  const database = useTestDatabase(6);
  let s: PortfolioSeason;
  beforeAll(async () => {
    s = await portfolioSeason(database.db);
  });
  const list = (when: Date, botsIncluded: boolean) => inTx(database.db, (tx) => participants(tx, s.seasonId, when, { botsIncluded }));

  it("rankings 16 e 17: ativo entra; bloqueado e excluído ficam fora; desbloqueado volta", async () => {
    const ok = await player(database.db, s.seasonId);
    const blocked = await player(database.db, s.seasonId, { status: "blocked" });
    const deleted = await player(database.db, s.seasonId, { status: "deleted" });
    const ids = (await list(br("2027-06-30 23:59"), false)).map((p) => p.walletId);
    expect(ids).toContain(ok.wallet);
    expect(ids).not.toContain(blocked.wallet);
    expect(ids).not.toContain(deleted.wallet);
    await setStatus(database.db, blocked.account.id, "active");
    expect((await list(br("2027-07-15 12:00"), false)).map((p) => p.walletId)).toContain(blocked.wallet);
  });

  it("rankings 4: quem entra depois de T não aparece em T", async () => {
    const late = await player(database.db, s.seasonId, { enteredAt: br("2027-06-20 10:00") });
    expect((await list(br("2027-05-31 23:59"), false)).map((p) => p.walletId)).not.toContain(late.wallet);
    expect((await list(br("2027-06-30 23:59"), false)).map((p) => p.walletId)).toContain(late.wallet);
  });

  it("rankings 6 e 7: bots só com a chave ligada (todos, ligados ou não); a tesouraria nunca", async () => {
    const b = await bot(database.db, s.seasonId, "dividendos");
    expect((await list(br("2027-06-30 23:59"), false)).map((p) => p.walletId)).not.toContain(b.wallet);
    const [treasury] = await openWallets(database.db, s.seasonId, [{ type: "treasury" }]);
    const withBots = await list(br("2027-06-30 23:59"), true);
    expect(withBots.find((p) => p.walletId === b.wallet)?.isBot).toBe(true);
    expect(withBots.some((p) => p.walletId === treasury)).toBe(false);
  });

  it("identities: apelido atual, conta excluída com nome nulo, bot com rótulo", async () => {
    const ana = await player(database.db, s.seasonId, { nickname: "ana_t4" });
    const gone = await player(database.db, s.seasonId, { status: "deleted" });
    const b = await bot(database.db, s.seasonId, "momentum");
    const map = await inTx(database.db, (tx) => identities(tx, [ana.wallet, gone.wallet, b.wallet]));
    expect(map.get(ana.wallet)).toMatchObject({ displayName: "ana_t4", isBot: false, botLabel: null });
    expect(map.get(gone.wallet)).toMatchObject({ displayName: null, isBot: false });
    expect(map.get(b.wallet)).toMatchObject({ displayName: null, isBot: true, botLabel: "Bot momentum" });
  });
});

describe("baseOf", () => {
  const database = useTestDatabase(6);
  let s: PortfolioSeason;
  let fla: number;
  beforeAll(async () => {
    s = await portfolioSeason(database.db);
    fla = s.clubIds.get("FLA3")!;
  });

  it("meses e instantes: o fechamento é às 23:59 de Brasília do último dia", () => {
    expect(previousMonthKey("2027-01")).toBe("2026-12");
    expect(closeAtOfMonth("2027-05").toISOString()).toBe("2027-06-01T02:59:00.000Z");
  });

  it("rankings 3 e 4: no primeiro mês e para quem entrou depois do fechamento anterior a base é R$ 100.000,00", async () => {
    const first = await player(database.db, s.seasonId);
    const late = await player(database.db, s.seasonId, { enteredAt: br("2027-06-20 10:00") });
    const people = await inTx(database.db, (tx) => participants(tx, s.seasonId, br("2027-06-30 23:59"), { botsIncluded: false }));
    // abril, o primeiro mês: ninguém tem mês anterior com carteira
    const april = await inTx(database.db, (tx) => baseOf(tx, s.seasonId, "2027-04", people.filter((p) => p.walletId === first.wallet)));
    expect(april.get(first.wallet)).toBe(BASE);
    const june = await inTx(database.db, (tx) => baseOf(tx, s.seasonId, "2027-06", people.filter((p) => p.walletId === late.wallet)));
    expect(june.get(late.wallet)).toBe(BASE);
  });

  it("a base é o patrimônio da versão atual do oficial anterior; quem não está lá usa o histórico; base ≤ 0 vem sem erro", async () => {
    const ana = await player(database.db, s.seasonId);
    const blockedMay = await player(database.db, s.seasonId); // ficou fora do oficial de maio, mas tinha patrimônio
    const broke = await player(database.db, s.seasonId);
    await setCash(database.db, ana.wallet, br("2027-05-10 12:00"), 11_200_000, fla);
    await setCash(database.db, blockedMay.wallet, br("2027-05-10 12:00"), 10_500_000, fla);
    await setCash(database.db, broke.wallet, br("2027-05-10 12:00"), -25_000, fla);
    const closeAt = closeAtOfMonth("2027-05");
    await inTx(database.db, async (tx) => {
      const head = { seasonId: s.seasonId, period: "month" as const, periodKey: "2027-05", closedAt: closeAt, botsIncluded: false, reason: null, createdAt: closeAt };
      await writeSnapshot(tx, { ...head, version: 1 }, [
        { walletId: ana.wallet, base: BASE, equity: 11_000_000, position: 1 },
        { walletId: broke.wallet, base: BASE, equity: -25_000, position: 2 },
      ]);
      // a versão 2 (recálculo) é a que vale
      await writeSnapshot(tx, { ...head, version: 2 }, [
        { walletId: ana.wallet, base: BASE, equity: 11_200_000, position: 1 },
        { walletId: broke.wallet, base: BASE, equity: -25_000, position: 2 },
      ]);
    });
    const people = await inTx(database.db, (tx) => participants(tx, s.seasonId, br("2027-06-30 23:59"), { botsIncluded: false }));
    const mine = people.filter((p) => [ana.wallet, blockedMay.wallet, broke.wallet].includes(p.walletId));
    const bases = await inTx(database.db, (tx) => baseOf(tx, s.seasonId, "2027-06", mine));
    expect(bases.get(ana.wallet)).toBe(11_200_000);
    expect(bases.get(blockedMay.wallet)).toBe(10_500_000);
    expect(bases.get(broke.wallet)).toBe(-25_000);
    const rows = await inTx(database.db, (tx) => currentRowsOf(tx, s.seasonId, "month", "2027-05"));
    expect(rows!.size).toBe(2);
  });
});

describe("buildRanking", () => {
  it("rankings 15 e P8: retornos iguais dividem a posição e o seguinte pula; sem base fica depois de todos, empatado", () => {
    const rows = buildRanking([
      { walletId: 1, equity: 10_500, base: 10_000 },
      { walletId: 2, equity: 21_000, base: 20_000 },
      { walletId: 3, equity: 20_000, base: 20_000 },
      { walletId: 4, equity: 500, base: -100 },
      { walletId: 5, equity: 800, base: 0 },
      { walletId: 6, equity: 30_000, base: 20_000 },
    ]);
    expect(rows.map((r) => [r.walletId, r.position])).toEqual([[6, 1], [1, 2], [2, 2], [3, 4], [4, 5], [5, 5]]);
    expect(rows.find((r) => r.walletId === 1)!.returnBp).toBe(500);
    expect(rows.find((r) => r.walletId === 4)!.returnBp).toBeNull();
  });
});

void at;
