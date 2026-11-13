import { describe, expect, it } from "vitest";
import {
  banFraudBodySchema,
  confirmFraudBodySchema,
  createFraudCaseBodySchema,
  dismissFraudBodySchema,
  pendingNoticeSchema,
} from "@futbolsa/contracts";
import { ADMIN_ACTIONS, reasonRequired } from "../../src/modules/admin/log/reasons.js";

describe("F14, T20: contratos da trapaça", () => {
  it("admin 33: confirmar, descartar e banir pedem motivo; abrir o relatório não", () => {
    for (const action of ["fraud.confirm", "fraud.dismiss", "fraud.ban"] as const) expect(reasonRequired(action), action).toBe(true);
    expect(reasonRequired("fraud.open")).toBe(false);
    expect(Object.keys(ADMIN_ACTIONS)).toContain("fraud.confirm");
    expect(confirmFraudBodySchema.safeParse({ tradeIds: [1, 2], reason: " " }).success).toBe(false);
    expect(dismissFraudBodySchema.safeParse({ reason: "x" }).success).toBe(false);
    expect(dismissFraudBodySchema.safeParse({ reason: "pares normais" }).success).toBe(true);
  });

  it("a confirmação pede ao menos um negócio, inteiros positivos", () => {
    const ok = { tradeIds: [7], reason: "combinaram os preços" };
    expect(confirmFraudBodySchema.safeParse(ok).success).toBe(true);
    expect(confirmFraudBodySchema.safeParse({ ...ok, tradeIds: [] }).success).toBe(false);
    expect(confirmFraudBodySchema.safeParse({ ...ok, tradeIds: [0] }).success).toBe(false);
    expect(confirmFraudBodySchema.safeParse({ ...ok, tradeIds: [1.5] }).success).toBe(false);
  });

  it("o relatório manual pede duas contas e um período que começa antes de terminar", () => {
    const user = { userId: "7f4f1f70-5b0f-4b5e-8f3a-3b1d8f0c9a10" };
    const body = { accountA: user, accountB: { botId: 12 }, from: "2026-07-01T00:00:00Z", to: "2026-07-31T23:59:59Z" };
    expect(createFraudCaseBodySchema.safeParse(body).success).toBe(true);
    expect(createFraudCaseBodySchema.safeParse({ ...body, to: "2026-06-01T00:00:00Z" }).success).toBe(false);
    expect(createFraudCaseBodySchema.safeParse({ ...body, ticker: "spt3" }).success).toBe(false);
    expect(createFraudCaseBodySchema.safeParse({ ...body, accountA: { userId: "x" } }).success).toBe(false);
  });

  it("o banimento pede a conta e o motivo", () => {
    expect(banFraudBodySchema.safeParse({ userId: "7f4f1f70-5b0f-4b5e-8f3a-3b1d8f0c9a10", reason: "reincidência" }).success).toBe(true);
    expect(banFraudBodySchema.safeParse({ userId: "7f4f1f70-5b0f-4b5e-8f3a-3b1d8f0c9a10", reason: "" }).success).toBe(false);
  });

  it("admin 43: o aviso não tem campo para a outra conta", () => {
    const notice = {
      id: 1,
      kind: "fraud_warning",
      createdAt: "2026-08-04T12:00:00Z",
      body: { reason: "preços combinados", trades: [{ at: "2026-08-03T15:00:00Z", ticker: "SPT3", quantity: 1, price: 770, value: 770 }] },
    };
    expect(pendingNoticeSchema.safeParse(notice).success).toBe(true);
    expect(pendingNoticeSchema.safeParse({ ...notice, body: { ...notice.body, counterparty: "Bruno" } }).success).toBe(false);
  });
});
