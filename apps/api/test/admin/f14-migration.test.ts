import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { ORDER_CANCEL_REASONS, WALLET_ENTRY_KINDS } from "../../src/infra/db/schema/index.js";
import { useTestDatabase } from "../support/db.js";

describe("F14, T6: a migração do admin de jogadores e bots", () => {
  const t = useTestDatabase(4);
  let indexes: string[];
  beforeAll(async () => {
    const r = await t.db.execute(sql`select indexname from pg_indexes where schemaname = 'futbolsa'`);
    indexes = r.rows.map((x) => String(x.indexname));
  });

  it("admin 34: a auditoria tem índice de negócios por carteira (comprador e vendedor)", () => {
    expect(indexes).toContain("trades_buyer_at_idx");
    expect(indexes).toContain("trades_seller_at_idx");
  });

  it("o banco aceita trade_annulled no extrato e annulment como motivo de cancelamento", async () => {
    expect(WALLET_ENTRY_KINDS).toContain("trade_annulled");
    expect(ORDER_CANCEL_REASONS).toContain("annulment");
    const r = await t.db.execute(sql`select pg_get_constraintdef(oid) as def from pg_constraint
      where conname in ('wallet_entries_kind_check','orders_cancel_reason_check') order by conname`);
    const defs = r.rows.map((x) => String(x.def));
    expect(defs[0]).toContain("annulment");
    expect(defs[1]).toContain("trade_annulled");
  });

  it("admin 42: negócio anulado é histórico e um caso de alerta aberto por par e clube é único", async () => {
    const tables = await t.db.execute(sql`select tgname from pg_trigger where tgname = 'trade_annulments_history'`);
    expect(tables.rows).toHaveLength(1);
    expect(indexes).toContain("fraud_cases_open_alert_key");
    expect(indexes).toContain("fraud_warnings_user_case_key");
  });
});
