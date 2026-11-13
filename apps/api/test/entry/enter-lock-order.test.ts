import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Database } from "../../src/infra/db/index.js";
import { lockClubs, lockSeason, pgErrorCode, withTransaction } from "../../src/infra/db/index.js";
import { deferred, sleep } from "../support/fixtures.js";
import { useEntryApp } from "./support.js";

/** Espera até alguma conexão do banco do teste estar parada numa trava de linha (a entrada chegou à espera). */
async function untilSomeoneWaitsOnALock(db: Database): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const { rows } = await db.execute(
      sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if ((rows[0] as { n: number }).n > 0) return;
    await sleep(50);
  }
  throw new Error("a entrada não chegou a esperar a trava do clube");
}

/**
 * T6, sabotagem 1: a ordem das travas no banco, e não só no `LockState`. Se o `FOR UPDATE` dos clubes travasse em outra
 * ordem que não a de ticker (o `ORDER BY` invertido no SQL, por exemplo), a conferência da ordem em memória não veria
 * nada; o que denuncia é a entrada segurar clubes enquanto espera um de ticker menor.
 */
describe("entrada no meio: ordem das travas (revisão T6)", () => {
  const e = useEntryApp({ clubs: 22 });

  it.each(["index", "cash"] as const)(
    "modo %s: esperando o clube de menor ticker, a entrada não segura nenhum outro clube",
    async (mode) => {
      const sorted = e.world.tickers.slice().sort();
      const owner = await e.newOwner();
      const held = deferred();
      const released = deferred();
      const holder = withTransaction(e.db, async (tx) => {
        await lockSeason(tx, e.world.seasonId, "share");
        await lockClubs(tx, e.world.seasonId, [sorted[0]!]);
        held.resolve();
        await released.promise;
      });
      await held.promise;
      const entering = e.service.enter(owner, mode);
      try {
        await untilSomeoneWaitsOnALock(e.db);
        // todos os outros clubes continuam livres: quem negocia um deles não espera a entrada
        const probe = await withTransaction(e.db, async (tx) => {
          await tx.db.execute(sql`select set_config('lock_timeout', '500ms', true)`);
          await lockSeason(tx, e.world.seasonId, "share");
          await lockClubs(tx, e.world.seasonId, sorted.slice(1));
        }).then(
          () => "livres",
          (error: unknown) => pgErrorCode(error) ?? String(error),
        );
        expect(probe).toBe("livres");
      } finally {
        released.resolve();
        await holder;
      }
      expect((await entering).created).toBe(true);
    },
    20_000,
  );
});
