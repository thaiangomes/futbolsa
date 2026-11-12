// @vitest-environment jsdom
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PayoutEventView } from "@futbolsa/contracts";
import { ApiError } from "../../../lib/api";
import type { AdminApi } from "../api";
import { anySettling, approvalSummary, eventState, groupEvents, newChangeKeys, stalePreview } from "./model";
import { PayoutsScreen } from "./screen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const render = async (element: ReactElement) => act(async () => root.render(element));
const text = () => container.textContent ?? "";
const buttons = (label: string) => [...container.querySelectorAll("button")].filter((b) => b.textContent?.trim().startsWith(label)) as HTMLButtonElement[];
const click = async (el: Element) => act(async () => (el as HTMLElement).click());

const club = (ticker: string) => ({ id: ticker.charCodeAt(0), ticker, name: ticker });
const event = (over: Partial<PayoutEventView> & { id: number }): PayoutEventView => ({
  key: `points|brasileirao-a|16|${over.id}`,
  kind: "points",
  club: club("FLA3"),
  competition: "brasileirao-a",
  round: 16,
  phase: null,
  reason: "6 pontos, rodada 16",
  perShare: 30,
  closedAt: "2027-05-10T03:00:00.000Z",
  status: "pending",
  version: 1,
  approvedAt: null,
  shares: { players: 800, bots: 200, total: 1000 },
  total: 30_000,
  standingsConfirmed: null,
  settlement: { state: "not_started", credited: 0, expected: 0 },
  ...over,
});
const fake = (events: PayoutEventView[], overrides: Partial<Record<keyof AdminApi, unknown>> = {}) =>
  ({ payouts: async () => ({ events }), ...overrides }) as unknown as AdminApi;

describe("regras da lista de pagamentos (prancha 7a)", () => {
  it("o bloqueio pela classificação vem antes do aguardando, e o liquidando mostra o progresso", () => {
    expect(eventState(event({ id: 1 })).kind).toBe("pending");
    expect(eventState(event({ id: 2, kind: "placement", standingsConfirmed: false })).kind).toBe("blocked");
    expect(eventState(event({ id: 3, kind: "placement", standingsConfirmed: true })).kind).toBe("pending");
    const settling = event({ id: 4, status: "approved", settlement: { state: "settling", credited: 3, expected: 9 } });
    expect(eventState(settling).label).toBe("Liquidando 3 de 9 carteiras");
    expect(anySettling([settling])).toBe(true);
    expect(eventState(event({ id: 5, status: "approved", settlement: { state: "settled", credited: 9, expected: 9 } })).label).toBe("Liquidado");
  });

  it("agrupa por competição e rodada, deixa de fora os substituídos e soma o total", () => {
    const groups = groupEvents([
      event({ id: 1 }),
      event({ id: 2, club: club("PAL3"), total: 10_000 }),
      event({ id: 3, round: 17 }),
      event({ id: 4, status: "superseded" }),
    ]);
    expect(groups.map((g) => [g.label, g.events.length, g.total])).toEqual([["Série A · rodada 16", 2, 40_000], ["Série A · rodada 17", 1, 30_000]]);
  });

  it("resume uma aprovação em lista com o que ficou para trás", () => {
    expect(approvalSummary({ results: [{ eventId: 1, outcome: "approved" }, { eventId: 2, outcome: "standings_not_confirmed" }] })).toBe(
      "1 evento aprovado; ficaram de fora 1 (classificação não conferida).",
    );
  });

  it("só trata como prévia desatualizada o correction_stale, com ou sem a prévia nova", () => {
    expect(stalePreview(new ApiError(409, "payout_settling", "x"))).toBeNull();
    expect(stalePreview(new ApiError(409, "correction_stale", "x"))).toEqual({ preview: null });
    const preview = { planCode: "b", changes: [], wallets: { receive: 0, pay: 0, negative: 0, buysCancelled: 0 }, months: [] };
    expect(stalePreview(new ApiError(409, "correction_stale", "x", undefined, { preview }))?.preview).toEqual(preview);
    expect(newChangeKeys(preview, preview).size).toBe(0);
  });
});

describe("tela de pagamentos aguardando (prancha 7a)", () => {
  it("lista por grupo, mostra o aviso do bloqueado e não deixa aprovar a colocação não conferida", async () => {
    await render(
      createElement(PayoutsScreen, {
        admin: fake([event({ id: 1 }), event({ id: 2, kind: "placement", competition: null, round: null, reason: "3º lugar", standingsConfirmed: false })]),
      }),
    );
    expect(text()).toContain("Série A · rodada 16");
    expect(text()).toContain("Bloqueado: classificação não conferida");
    expect(text()).toContain("Confira a classificação oficial antes de aprovar");
    expect(buttons("Aprovar todos os aguardando")[0]!.textContent).toContain("(1)");
    expect(buttons("Aprovar").filter((b) => b.textContent?.trim() === "Aprovar")).toHaveLength(1);
  });

  it("aprovar pede confirmação, manda só o evento e mostra o resumo", async () => {
    const approve = vi.fn(async () => ({ results: [{ eventId: 1, outcome: "approved" as const }] }));
    await render(createElement(PayoutsScreen, { admin: fake([event({ id: 1 })], { approvePayouts: approve }) }));
    await click(buttons("Aprovar").find((b) => b.textContent?.trim() === "Aprovar")!);
    expect(approve).not.toHaveBeenCalled();
    await click(buttons("Confirmar")[0]!);
    expect(approve).toHaveBeenCalledWith({ eventIds: [1] });
    expect(text()).toContain("1 evento aprovado");
  });

  it("aprovar todos manda all e a lista recarrega; Voltar desiste sem chamar a API", async () => {
    const approve = vi.fn(async () => ({ results: [{ eventId: 1, outcome: "approved" as const }] }));
    await render(createElement(PayoutsScreen, { admin: fake([event({ id: 1 })], { approvePayouts: approve }) }));
    await click(buttons("Aprovar todos")[0]!);
    await click(buttons("Voltar")[0]!);
    expect(approve).not.toHaveBeenCalled();
    await click(buttons("Aprovar todos")[0]!);
    await click(buttons("Confirmar")[0]!);
    expect(approve).toHaveBeenCalledWith({ all: true });
  });

  it("um evento substituído no meio mostra o erro da API e recarrega a lista", async () => {
    let calls = 0;
    const payouts = vi.fn(async () => ({ events: [event({ id: calls++ === 0 ? 1 : 9 })] }));
    const approve = vi.fn(async () => {
      throw new ApiError(409, "event_superseded", "Este evento foi substituído por uma versão nova.");
    });
    await render(createElement(PayoutsScreen, { admin: fake([], { payouts, approvePayouts: approve }) }));
    await click(buttons("Aprovar").find((b) => b.textContent?.trim() === "Aprovar")!);
    await click(buttons("Confirmar")[0]!);
    expect(text()).toContain("substituído por uma versão nova");
    expect(payouts).toHaveBeenCalledTimes(2);
  });

  it("enquanto há evento liquidando a tela recarrega sozinha", async () => {
    vi.useFakeTimers();
    const settling = event({ id: 1, status: "approved", settlement: { state: "settling", credited: 1, expected: 4 } });
    const payouts = vi.fn(async () => ({ events: [settling] }));
    await render(createElement(PayoutsScreen, { admin: fake([], { payouts }) }));
    expect(payouts).toHaveBeenCalledTimes(1);
    await act(async () => void (await vi.advanceTimersByTimeAsync(3100)));
    expect(payouts.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(text()).toContain("Liquidando 1 de 4 carteiras");
  });

  it("os donos do evento abrem com a paginação e marcam bot e conta excluída", async () => {
    const holders = vi.fn(async () => ({
      holders: [
        { walletId: 1, kind: "player" as const, nickname: "ana", shares: 600, amount: 18_000, credited: 18_000 },
        { walletId: 2, kind: "bot" as const, nickname: "Pé-frio", shares: 200, amount: 6_000, credited: null },
        { walletId: 3, kind: "deleted" as const, nickname: null, shares: 50, amount: 0, credited: null },
      ],
      page: 1,
      pageSize: 50,
      total: 3,
    }));
    await render(createElement(PayoutsScreen, { admin: fake([event({ id: 1 })], { payoutHolders: holders }) }));
    await click(buttons("Donos")[0]!);
    expect(holders).toHaveBeenCalledWith(1, 1);
    expect(text()).toContain("bot Pé-frio");
    expect(text()).toContain("conta excluída (não recebe)");
    expect(text()).toContain("3 donos · página 1 de 1");
  });
});
