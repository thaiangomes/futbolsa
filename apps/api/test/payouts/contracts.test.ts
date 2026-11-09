import "reflect-metadata";
import { describe, expect, it } from "vitest";
import {
  adminPendingEventSchema,
  approvePayoutsBodySchema,
  approvePayoutsResponseSchema,
  applyCorrectionBodySchema,
  correctionPreviewSchema,
  EVENT_CATALOG,
  payoutCreditedEventSchema,
  payoutHoldersQuerySchema,
  payoutHoldersResponseSchema,
  payoutListQuerySchema,
  payoutListResponseSchema,
} from "@futbolsa/contracts";
import { AdminModule } from "../../src/modules/admin/admin.module.js";
import { ADMIN_ACTIONS, reasonRequired } from "../../src/modules/admin/log/reasons.js";
import { NoopRankingsPort, RankingsPort } from "../../src/modules/admin/payouts/ports.js";
import { PayoutsModule } from "../../src/modules/admin/payouts/payouts.module.js";

const club = { id: 1, ticker: "FLA3", name: "Flamengo" };

describe("contratos dos pagamentos", () => {
  it("o AdminModule registra a subpasta de pagamentos", () => {
    const imports = Reflect.getMetadata("imports", AdminModule) as unknown[];
    expect(imports).toContain(PayoutsModule);
  });

  it("admin 33: aprovar sem motivo é aceito, mas aplicar a correção exige motivo", () => {
    expect(reasonRequired("payout.approve")).toBe(false);
    expect(reasonRequired("payout.correct")).toBe(true);
    expect(Object.keys(ADMIN_ACTIONS)).toEqual(expect.arrayContaining(["payout.approve", "payout.correct"]));
    expect(applyCorrectionBodySchema.safeParse({ planCode: "abc123" }).success).toBe(false);
    expect(applyCorrectionBodySchema.safeParse({ planCode: "abc123", reason: "  ab " }).success).toBe(false);
    expect(applyCorrectionBodySchema.parse({ planCode: "abc123", reason: "  placar errado  " })).toEqual({
      planCode: "abc123",
      reason: "placar errado",
    });
  });

  it("a aprovação recebe uma lista de eventos ou 'todos os pendentes', nunca os dois nem nenhum", () => {
    expect(approvePayoutsBodySchema.parse({ eventIds: [3, 4] })).toEqual({ eventIds: [3, 4] });
    expect(approvePayoutsBodySchema.parse({ all: true })).toEqual({ all: true });
    expect(approvePayoutsBodySchema.safeParse({}).success).toBe(false);
    expect(approvePayoutsBodySchema.safeParse({ eventIds: [] }).success).toBe(false);
    expect(approvePayoutsBodySchema.safeParse({ eventIds: [1], all: true }).success).toBe(false);
    expect(approvePayoutsBodySchema.safeParse({ all: false }).success).toBe(false);
    expect(approvePayoutsBodySchema.safeParse({ eventIds: [1.5] }).success).toBe(false);
  });

  it("a resposta da aprovação lista o resultado de cada evento", () => {
    const parsed = approvePayoutsResponseSchema.parse({
      results: [
        { eventId: 1, outcome: "approved" },
        { eventId: 2, outcome: "already_approved" },
        { eventId: 3, outcome: "event_superseded" },
        { eventId: 4, outcome: "standings_not_confirmed" },
        { eventId: 5, outcome: "not_found" },
      ],
    });
    expect(parsed.results).toHaveLength(5);
    expect(approvePayoutsResponseSchema.safeParse({ results: [{ eventId: 1, outcome: "pago" }] }).success).toBe(false);
  });

  it("a lista de pagamentos filtra por situação, competição, rodada ou fase", () => {
    expect(payoutListQuerySchema.parse({})).toEqual({});
    expect(payoutListQuerySchema.parse({ status: "pending", competition: "brasileirao-a", round: "10" })).toEqual({
      status: "pending",
      competition: "brasileirao-a",
      round: 10,
    });
    expect(payoutListQuerySchema.parse({ competition: "copa-do-brasil", phase: "oitavas" }).phase).toBe("oitavas");
    expect(payoutListQuerySchema.safeParse({ status: "pago" }).success).toBe(false);
  });

  it("admin 2: a prévia traz motivo, valor por ação, ações de jogadores e de bots, total e a conferência", () => {
    const parsed = payoutListResponseSchema.parse({
      events: [
        {
          id: 7,
          key: "points|brasileirao-a|10|FLA3",
          kind: "points",
          club,
          competition: "brasileirao-a",
          round: 10,
          phase: null,
          reason: "3 pontos, rodada 10",
          perShare: 30,
          closedAt: "2027-04-01T23:00:00.000Z",
          status: "pending",
          version: 1,
          approvedAt: null,
          shares: { players: 3000, bots: 500, total: 3500 },
          total: 105_000,
          standingsConfirmed: null,
          settlement: { state: "not_started", credited: 0, expected: 0 },
        },
      ],
    });
    expect(parsed.events[0]!.total).toBe(105_000);
    expect(payoutListResponseSchema.safeParse({ events: [{ id: 7 }] }).success).toBe(false);
  });

  it("os donos de um evento vêm paginados, com bot marcado e conta excluída à parte", () => {
    expect(payoutHoldersQuerySchema.parse({})).toEqual({ page: 1, pageSize: 50 });
    expect(payoutHoldersQuerySchema.parse({ page: "2", pageSize: "100" })).toEqual({ page: 2, pageSize: 100 });
    expect(payoutHoldersQuerySchema.safeParse({ pageSize: "1000" }).success).toBe(false);
    const parsed = payoutHoldersResponseSchema.parse({
      holders: [
        { walletId: 1, kind: "player", nickname: "ana", shares: 1000, amount: 30_000, credited: null },
        { walletId: 2, kind: "bot", nickname: null, shares: 500, amount: 15_000, credited: 15_000 },
        { walletId: 3, kind: "deleted", nickname: null, shares: 10, amount: 0, credited: null },
      ],
      page: 1,
      pageSize: 50,
      total: 3,
    });
    expect(parsed.holders.map((h) => h.kind)).toEqual(["player", "bot", "deleted"]);
  });

  it("admin 12: a prévia da correção traz as diferenças, o resumo por carteira, os meses e o código", () => {
    const parsed = correctionPreviewSchema.parse({
      planCode: "a".repeat(64),
      changes: [
        {
          key: "points|brasileirao-a|10|CAM3",
          kind: "points",
          club: { id: 2, ticker: "CAM3", name: "Atlético" },
          competition: "brasileirao-a",
          round: 10,
          phase: null,
          reason: "1 ponto, rodada 10",
          before: 30,
          after: 10,
          delta: -20,
          closedAtBefore: "2027-04-01T23:00:00.000Z",
          closedAtAfter: "2027-04-01T23:00:00.000Z",
          shares: 2000,
          total: -40_000,
          outcome: "correction",
        },
      ],
      wallets: { receive: 1, pay: 1, negative: 1, buysCancelled: 0 },
      months: ["2027-04"],
    });
    expect(parsed.changes[0]!.delta).toBe(-20);
    expect(correctionPreviewSchema.safeParse({ planCode: "x", changes: [] }).success).toBe(false);
  });

  it("os eventos de tempo real: payout.credited no canal me e admin.pending no admin", () => {
    expect(EVENT_CATALOG["payout.credited"]).toBe("me");
    expect(EVENT_CATALOG["admin.pending"]).toBe("admin");
    const credited = {
      eventId: 7,
      kind: "dividend",
      ticker: "FLA3",
      reason: "3 pontos, rodada 10",
      amount: 30_000,
    };
    expect(payoutCreditedEventSchema.parse(credited)).toEqual(credited);
    expect(payoutCreditedEventSchema.parse({ ...credited, kind: "reversal", amount: -40_000 }).amount).toBe(-40_000);
    expect(payoutCreditedEventSchema.safeParse({ ...credited, kind: "buyback" }).success).toBe(false);
    // o que já existia segue valendo, e os pagamentos aguardando entram como campo opcional
    expect(adminPendingEventSchema.parse({ pendingMatches: 2 })).toEqual({ pendingMatches: 2 });
    expect(adminPendingEventSchema.parse({ pendingMatches: 2, pendingPayouts: 4 })).toEqual({ pendingMatches: 2, pendingPayouts: 4 });
  });
});

describe("porta dos rankings (F13)", () => {
  it("a implementação vazia aceita o aviso e o despertar sem fazer nada", async () => {
    const port: RankingsPort = new NoopRankingsPort();
    await expect(
      port.payoutsChanged({} as never, { seasonId: 1, closedAts: [new Date("2027-04-01T23:00:00Z")] }),
    ).resolves.toBeUndefined();
    await expect(port.wake()).resolves.toBeUndefined();
  });
});
