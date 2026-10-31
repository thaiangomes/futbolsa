import { beforeAll, describe, expect, it } from "vitest";
import { lockClubs, lockSeason, lockWallets } from "../../src/infra/db/locks.js";
import { LockOrderError, withTransaction } from "../../src/infra/db/transaction.js";
import { useTestDatabase } from "../support/db.js";
import { createUser, deferred, listClubs, openWallets, seedSeason, sleep } from "../support/fixtures.js";

describe("T6: travas em ordem", () => {
  const t = useTestDatabase();
  let seasonId: number;
  let treasury: number;
  let players: number[];

  beforeAll(async () => {
    const seeded = await seedSeason(t.db);
    seasonId = seeded.seasonId;
    await listClubs(t.db, seasonId, seeded.clubIds, ["BOT3", "FLA3", "PAL3"]);
    // a tesouraria nasce antes dos jogadores: tem o menor id
    const ids = await openWallets(t.db, seasonId, [
      { type: "treasury" },
      { type: "user", userId: await createUser(t.db) },
      { type: "user", userId: await createUser(t.db) },
      { type: "user", userId: await createUser(t.db) },
    ]);
    treasury = ids[0]!;
    players = ids.slice(1);
  });

  it("clubes pedidos em ordem trocada ao mesmo tempo, 50 vezes, sem nenhum deadlock", async () => {
    let retries = 0;
    const onRetry = () => retries++;
    for (let i = 0; i < 50; i++) {
      await Promise.all([
        withTransaction(
          t.db,
          async (tx) => {
            await lockClubs(tx, seasonId, ["PAL3", "FLA3"]);
            await sleep(2);
          },
          { onRetry },
        ),
        withTransaction(
          t.db,
          async (tx) => {
            await lockClubs(tx, seasonId, ["FLA3", "PAL3"]);
            await sleep(2);
          },
          { onRetry },
        ),
      ]);
    }
    expect(retries).toBe(0);
  });

  it("trava de fato na ordem de ticker: com o PAL3 preso, quem pede PAL3 e FLA3 já segura o FLA3 enquanto espera", async () => {
    const holdingPal = deferred();
    const releasePal = deferred();
    const holder = withTransaction(t.db, async (tx) => {
      await lockClubs(tx, seasonId, ["PAL3"]);
      holdingPal.resolve();
      await releasePal.promise;
    });
    await holdingPal.promise;
    // pede na ordem contrária; trava o FLA3 e fica esperando o PAL3
    const both = withTransaction(t.db, (tx) => lockClubs(tx, seasonId, ["PAL3", "FLA3"]));
    await sleep(100);
    let flaFree = false;
    const probe = withTransaction(t.db, async (tx) => {
      await lockClubs(tx, seasonId, ["FLA3"]);
      flaFree = true;
    });
    await sleep(100);
    // se a trava seguisse a ordem pedida, o FLA3 estaria livre
    expect(flaFree).toBe(false);
    releasePal.resolve();
    await Promise.all([holder, both, probe]);
    expect(flaFree).toBe(true);
  });

  it("devolve os clubes em ordem de ticker, com o preço exibido", async () => {
    const rows = await withTransaction(t.db, (tx) => lockClubs(tx, seasonId, ["PAL3", "BOT3", "FLA3", "PAL3"]));
    expect(rows.map((r) => r.ticker)).toEqual(["BOT3", "FLA3", "PAL3"]);
    expect(rows[0]!.lastPrice).toBe(4000);
  });

  it("o mesmo clube espera o COMMIT; um clube diferente negocia em paralelo", async () => {
    const events: string[] = [];
    const holding = deferred();
    const release = deferred();
    const first = withTransaction(t.db, async (tx) => {
      await lockClubs(tx, seasonId, ["FLA3"]);
      holding.resolve();
      await release.promise;
      events.push("A grava FLA3");
    });
    await holding.promise;
    const same = withTransaction(t.db, async (tx) => {
      await lockClubs(tx, seasonId, ["FLA3"]);
      events.push("B trava FLA3");
    });
    await withTransaction(t.db, async (tx) => {
      await lockClubs(tx, seasonId, ["PAL3"]);
      events.push("C trava PAL3");
    });
    await sleep(50);
    expect(events).toEqual(["C trava PAL3"]);
    release.resolve();
    await Promise.all([first, same]);
    expect(events).toEqual(["C trava PAL3", "A grava FLA3", "B trava FLA3"]);
  });

  it("carteiras em ordem de id, com a tesouraria por último mesmo tendo o menor id", async () => {
    const rows = await withTransaction(t.db, (tx) => lockWallets(tx, [treasury, players[2]!, players[0]!]));
    expect(rows.map((r) => r.id)).toEqual([players[0], players[2], treasury]);
  });

  it("carteiras pedidas em ordem trocada ao mesmo tempo não dão deadlock", async () => {
    let retries = 0;
    const onRetry = () => retries++;
    for (let i = 0; i < 30; i++) {
      await Promise.all([
        withTransaction(t.db, async (tx) => {
          await lockWallets(tx, [treasury, players[1]!, players[0]!]);
          await sleep(2);
        }, { onRetry }),
        withTransaction(t.db, async (tx) => {
          await lockWallets(tx, [players[0]!, players[1]!, treasury]);
          await sleep(2);
        }, { onRetry }),
      ]);
    }
    expect(retries).toBe(0);
  });

  it("recusa travar fora da ordem: clube depois de carteira, ticker ou id menor numa segunda chamada", async () => {
    const outOfOrder = (fn: Parameters<typeof withTransaction>[1]) =>
      expect(withTransaction(t.db, fn)).rejects.toBeInstanceOf(LockOrderError);
    await outOfOrder(async (tx) => {
      await lockWallets(tx, [players[0]!]);
      await lockClubs(tx, seasonId, ["FLA3"]);
    });
    await outOfOrder(async (tx) => {
      await lockClubs(tx, seasonId, ["PAL3"]);
      await lockClubs(tx, seasonId, ["FLA3"]);
    });
    await outOfOrder(async (tx) => {
      await lockWallets(tx, [players[1]!]);
      await lockWallets(tx, [players[0]!]);
    });
    await outOfOrder(async (tx) => {
      await lockWallets(tx, [treasury]);
      await lockWallets(tx, [players[2]!]);
    });
    await outOfOrder(async (tx) => {
      await lockClubs(tx, seasonId, ["FLA3"]);
      await lockSeason(tx, seasonId, "share");
    });
    await outOfOrder(async (tx) => {
      await lockSeason(tx, seasonId, "share");
      await lockSeason(tx, seasonId, "update");
    });
  });

  it("aceita a ordem certa em várias chamadas e travar de novo o que já está travado", async () => {
    await withTransaction(t.db, async (tx) => {
      await lockSeason(tx, seasonId, "update");
      await lockClubs(tx, seasonId, ["BOT3"]);
      await lockClubs(tx, seasonId, ["BOT3", "FLA3"]);
      await lockClubs(tx, seasonId, ["PAL3"]);
      await lockWallets(tx, [players[0]!]);
      await lockWallets(tx, [players[0]!, players[1]!]);
      await lockWallets(tx, [treasury]);
      expect(tx.locks.isWalletLocked(treasury)).toBe(true);
    });
  });

  it("ticker que não está listado na temporada dá erro com o ticker no texto", async () => {
    await expect(withTransaction(t.db, (tx) => lockClubs(tx, seasonId, ["FLA3", "SAN3"]))).rejects.toThrow(/SAN3/);
  });
});
