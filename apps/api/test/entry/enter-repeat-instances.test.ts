import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../../src/infra/db/index.js";
import { lockClubs, lockSeason, withTransaction } from "../../src/infra/db/index.js";
import { EntryService } from "../../src/modules/entry/enter.service.js";
import { EntryGate } from "../../src/modules/entry/entry-gate.js";
import { EntryEvents } from "../../src/modules/entry/events.js";
import { PortfolioLedger } from "../../src/modules/portfolio/index.js";
import { deferred, sleep } from "../support/fixtures.js";
import { assertSharesConserved } from "../support/invariants.js";
import { useEntryApp } from "./support.js";

/** Espera até `n` conexões do banco do teste estarem paradas numa trava de linha. */
async function untilWaitingOnLocks(db: Database, n: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const { rows } = await db.execute(
      sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if ((rows[0] as { n: number }).n >= n) return;
    await sleep(50);
  }
  throw new Error(`menos de ${n} conexões esperando trava`);
}

/**
 * T6, sabotagem 4: a conferência da carteira existente depois da trava (passo 8 da transação). Numa instância só, o
 * semáforo enfileira as chamadas e a chave única `wallets_season_user_key` (erro 23505) devolve a mesma resposta mesmo
 * sem o passo 8, então os testes de repetição não o enxergam. Aqui são duas instâncias da API (um semáforo cada), as
 * duas esperando o mesmo clube: a segunda tem de achar a carteira da primeira no passo 8, sem tentar abrir outra (sem
 * emitir de novo e sem depender do 23505).
 */
describe("entrada no meio: repetição com duas instâncias da API (revisão T6)", () => {
  const e = useEntryApp({ clubs: 22 });
  afterEach(() => vi.restoreAllMocks());

  /** Uma segunda instância: o mesmo banco, o mesmo extrato, outro semáforo. */
  const otherInstance = () =>
    new EntryService(e.db, e.clock, e.app.get(PortfolioLedger), new EntryGate(), e.app.get(EntryEvents));

  async function race(modes: readonly ["index" | "cash", "index" | "cash"]) {
    const sorted = e.world.tickers.slice().sort();
    const owner = await e.newOwner();
    const opened = vi.spyOn(e.app.get(PortfolioLedger), "openWallet");
    const held = deferred();
    const released = deferred();
    const holder = withTransaction(e.db, async (tx) => {
      await lockSeason(tx, e.world.seasonId, "share");
      await lockClubs(tx, e.world.seasonId, [sorted[0]!]);
      held.resolve();
      await released.promise;
    });
    await held.promise;
    const settle = <T>(p: Promise<T>) => p.then((v) => ({ ok: v }), (error: { code?: string }) => ({ error }));
    const first = settle(e.service.enter(owner, modes[0]));
    const second = settle(otherInstance().enter(owner, modes[1]));
    try {
      // as duas passaram pelo atalho sem trava e esperam o mesmo clube
      await untilWaitingOnLocks(e.db, 2);
    } finally {
      released.resolve();
      await holder;
    }
    return { outcomes: await Promise.all([first, second]), opened, owner };
  }

  it("mesmo modo: uma carteira, uma emissão, a outra resposta repetida, e a carteira é aberta uma vez só", async () => {
    const totals = async () =>
      ((await e.db.execute(sql`select sum(total_shares)::bigint as s from futbolsa.season_clubs`)).rows[0] as { s: string }).s;
    const before = BigInt(await totals());
    const { outcomes, opened } = await race(["index", "index"]);
    const ok = outcomes.map((o) => ("ok" in o ? o.ok : undefined));
    expect(ok.every((o) => o !== undefined)).toBe(true);
    expect(ok.filter((o) => o!.created)).toHaveLength(1);
    expect(ok.filter((o) => o!.result.repeated)).toHaveLength(1);
    // o passo 8 respondeu: ninguém tentou abrir a segunda carteira (o 23505 é a rede, não o caminho)
    expect(opened).toHaveBeenCalledTimes(1);
    const n = ok.find((o) => o!.created)!.result.n;
    expect(BigInt(await totals())).toBe(before + BigInt(n * e.world.tickers.length));
    await assertSharesConserved(e.db, e.world.seasonId);
  }, 30_000);

  it("outro modo: a segunda recebe already_entered sem tentar abrir outra carteira", async () => {
    const { outcomes, opened } = await race(["index", "cash"]);
    const codes = outcomes.map((o) => ("ok" in o ? (o.ok.created ? "created" : "repeated") : o.error.code));
    expect(codes.sort()).toEqual(["already_entered", "created"]);
    expect(opened).toHaveBeenCalledTimes(1);
  }, 30_000);
});
