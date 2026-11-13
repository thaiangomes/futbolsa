import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { wallets } from "../../src/infra/db/schema/index.js";
import { EntryEvents } from "../../src/modules/entry/events.js";
import { PortfolioLedger } from "../../src/modules/portfolio/index.js";
import { assertLedgerConsistent, assertSharesConserved } from "../support/invariants.js";
import { useEntryApp } from "./support.js";

/** Uma fotografia do que a entrada escreve: se voltar igual, a transação desfez tudo. */
async function snapshot(e: ReturnType<typeof useEntryApp>) {
  const q = async (text: ReturnType<typeof sql>) => (await e.db.execute(text)).rows;
  return {
    totals: await q(sql`select club_id, total_shares from futbolsa.season_clubs order by club_id`),
    wallets: await q(sql`select id, owner_type, cash, reserved_cash from futbolsa.wallets order by id`),
    positions: await q(sql`select wallet_id, club_id, shares, cost from futbolsa.positions order by wallet_id, club_id`),
    entries: await q(sql`select count(*)::int as n, coalesce(sum(cash_delta), 0)::bigint as cash, coalesce(sum(shares_delta), 0)::bigint as shares from futbolsa.wallet_entries`),
  };
}

describe("entrada no meio: falha desfaz tudo (tudo ou nada)", () => {
  const e = useEntryApp({ clubs: 22 });
  afterEach(() => vi.restoreAllMocks());

  const boom = new Error("falha injetada");

  it.each([
    ["depois do UPDATE de total_shares e antes de abrir a carteira", "openWallet-before"],
    ["depois de abrir a carteira, antes do extrato da emissão", "postMany-before"],
    ["depois do extrato da emissão (carteira índice)", "postMany-after"],
    ["depois dos avisos, no fim da transação", "events"],
  ])("índice: falha %s", async (_nome, where) => {
    const owner = await e.newOwner();
    const before = await snapshot(e);
    const ledger = e.app.get(PortfolioLedger);
    if (where === "openWallet-before") vi.spyOn(ledger, "openWallet").mockRejectedValue(boom);
    if (where === "postMany-before") vi.spyOn(ledger, "postMany").mockRejectedValue(boom);
    if (where === "postMany-after") {
      const real = ledger.postMany.bind(ledger);
      vi.spyOn(ledger, "postMany").mockImplementation(async (tx, m) => {
        await real(tx, m);
        throw boom;
      });
    }
    if (where === "events") vi.spyOn(e.app.get(EntryEvents), "entered").mockImplementation(() => {
      throw boom;
    });
    await expect(e.service.enter(owner, "index")).rejects.toThrow("falha injetada");
    expect(await snapshot(e)).toEqual(before);
    // e nada ficou para trás: a pessoa consegue entrar depois
    vi.restoreAllMocks();
    const ok = await e.service.enter(owner, "index");
    expect(ok.created).toBe(true);
  });

  it.each([
    ["depois do UPDATE de total_shares", "openWallet-before"],
    ["depois de abrir a carteira", "postMany-before"],
    ["depois do extrato da tesouraria", "postMany-after"],
  ])("só caixa: falha %s", async (_nome, where) => {
    const owner = await e.newOwner();
    const before = await snapshot(e);
    const ledger = e.app.get(PortfolioLedger);
    if (where === "openWallet-before") vi.spyOn(ledger, "openWallet").mockRejectedValue(boom);
    if (where === "postMany-before") vi.spyOn(ledger, "postMany").mockRejectedValue(boom);
    if (where === "postMany-after") {
      const real = ledger.postMany.bind(ledger);
      vi.spyOn(ledger, "postMany").mockImplementation(async (tx, m) => {
        await real(tx, m);
        throw boom;
      });
    }
    await expect(e.service.enter(owner, "cash")).rejects.toThrow("falha injetada");
    expect(await snapshot(e)).toEqual(before);
  });

  it("depois de todas as falhas, as invariantes continuam de pé", async () => {
    await assertSharesConserved(e.db, e.world.seasonId);
    await assertLedgerConsistent(e.db, e.world.seasonId);
    const w = await e.db.select().from(wallets).where(eq(wallets.seasonId, e.world.seasonId));
    expect(w.length).toBeGreaterThan(0);
  });
});
