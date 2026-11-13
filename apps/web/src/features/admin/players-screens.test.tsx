// @vitest-environment jsdom
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlayerDetail } from "@futbolsa/contracts";
import type { AdminApi } from "./api";
import { AuditScreen, brasiliaToIso } from "./audit-screen";
import { BotsScreen, describeChange } from "./bots-screen";
import { deleteConfirmed, previewAdjust } from "./players-logic";
import { PlayerDetailScreen, PlayersScreen } from "./players-screen";

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
});

const render = (element: ReactElement) => act(async () => root.render(element));
const $ = <T extends Element = HTMLElement>(selector: string) => container.querySelector(selector) as T;
const text = () => container.textContent ?? "";
const button = (label: string) => [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;
async function type(selector: string, value: string) {
  const input = $<HTMLInputElement>(selector);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const click = (el: Element) => act(async () => (el as HTMLElement).click());
const fake = (overrides: Partial<Record<keyof AdminApi, unknown>>) => overrides as unknown as AdminApi;

const club = (ticker: string) => ({ ticker, name: ticker, badgeAbbr: null, colorPrimary: null, colorSecondary: null });
const ID = "11111111-1111-4111-8111-111111111111";
const detail = (over: Partial<PlayerDetail> = {}): PlayerDetail => ({
  account: { id: ID, nickname: "Ana", email: "ana@exemplo.com", role: "player", status: "active", blockedReason: null, createdAt: "2027-03-01T12:00:00.000Z", deletedAt: null },
  wallet: {
    seq: 0, at: "2027-04-06T18:00:00.000Z", cash: { total: 10_000, reserved: 8000, free: 2000 }, negativeCash: false, receivable: 0, stocksValue: 4000, equity: 14_000, returnBp: 0, buybackClosed: false,
    positions: [{ club: club("FLA3"), shares: 10, inOrders: 6, free: 4, averagePrice: 400, cost: 4000, price: 400, marketValue: 4000, unrealized: 0, unrealizedPermille: 0, dividends: 0, receivable: 0, shareOfEquityPermille: 100, auction: null }],
    results: [],
  },
  entryMode: "ipo",
  openOrders: [],
  bids: [],
  ...over,
} as PlayerDetail);

describe("ajustar saldo: a prévia e as recusas (Admin 27 e 28)", () => {
  it("caixa: mostra o saldo depois e recusa o débito acima do livre", () => {
    expect(previewAdjust(detail(), { asset: "cash", delta: 1000 })).toEqual({ lines: ["Caixa: R$ 100,00 → R$ 110,00"], refusal: null });
    expect(previewAdjust(detail(), { asset: "cash", delta: -5000 }).refusal).toMatch(/caixa livre/);
    expect(previewAdjust(detail(), { asset: "cash", delta: -2000 }).refusal).toBeNull();
  });
  it("ações: crédito mostra o custo pelo preço exibido; débito recusa o que está em ordens de venda", () => {
    const credit = previewAdjust(detail(), { asset: "shares", ticker: "FLA3", delta: 5 });
    expect(credit.lines[0]).toBe("FLA3: 10 → 15 ações");
    expect(credit.lines[1]).toContain("preço exibido");
    expect(credit.lines[1]).toContain("R$ 20,00");
    expect(previewAdjust(detail(), { asset: "shares", ticker: "FLA3", delta: -5 }).refusal).toMatch(/4 ações livres/);
    expect(previewAdjust(detail(), { asset: "shares", ticker: "FLA3", delta: -4 }).refusal).toBeNull();
  });
  it("sem carteira ou com delta zero não há prévia", () => {
    expect(previewAdjust(detail({ wallet: null }), { asset: "cash", delta: 1 }).refusal).toMatch(/carteira/);
    expect(previewAdjust(detail(), { asset: "cash", delta: 0 }).refusal).toMatch(/diferente de zero/);
  });
  it("excluir só liga com o apelido digitado igual e um motivo", () => {
    expect(deleteConfirmed("Ana", "ana", "pedido do titular")).toBe(false);
    expect(deleteConfirmed("Ana", "Ana", "ab")).toBe(false);
    expect(deleteConfirmed("Ana", "Ana", "pedido do titular")).toBe(true);
    expect(deleteConfirmed(null, "", "pedido do titular")).toBe(false);
  });
});

describe("jogadores (tela)", () => {
  it("a lista mostra o patrimônio, esconde a conta excluída e a busca manda o texto e a situação", async () => {
    const players = vi.fn(async (q?: { q?: string; status?: string }) =>
      q?.q
        ? { items: [{ id: ID, nickname: "Ana", role: "player", status: "active", createdAt: "2027-03-01T12:00:00.000Z", equity: 10_000_000 }], nextCursor: null }
        : {
            items: [
              { id: ID, nickname: "Ana", role: "player", status: "blocked", createdAt: "2027-03-01T12:00:00.000Z", equity: 10_000_000 },
              { id: "22222222-2222-4222-8222-222222222222", nickname: null, role: "player", status: "deleted", createdAt: "2027-03-01T12:00:00.000Z", equity: null },
            ],
            nextCursor: null,
          },
    );
    await render(createElement(PlayersScreen, { admin: fake({ players }) }));
    expect(text()).toContain("Bloqueado");
    expect(text()).toContain("conta excluída");
    expect($<HTMLAnchorElement>("a[href^='/admin/jogador?id=']").getAttribute("href")).toBe(`/admin/jogador?id=${ID}`);
    await type("#busca", "an");
    await click(button("Buscar"));
    expect(players).toHaveBeenLastCalledWith({ q: "an" });
    expect(text()).toContain("R$ 100.000,00");
  });

  it("admin 25 e 33: bloquear só liga com o motivo e o motivo vai para a API; a conta bloqueada oferece desbloquear", async () => {
    const blockPlayer = vi.fn(async () => ({ status: "blocked", cancelledOrders: 1, cancelledBids: 0 }));
    const player = vi.fn(async () => detail());
    await render(createElement(PlayerDetailScreen, { admin: fake({ player, playerEntries: async () => ({ items: [], nextCursor: null }), blockPlayer }), id: ID }));
    const block = [...container.querySelectorAll("button")].find((b) => b.textContent === "Bloquear" && b.type === "submit") as HTMLButtonElement;
    expect(block.disabled).toBe(true);
    await type("#motivo-bloqueio", "suspeita de trapaça");
    expect(block.disabled).toBe(false);
    await click(block);
    expect(blockPlayer).toHaveBeenCalledWith(ID, "suspeita de trapaça");
  });

  it("admin 26: excluir só habilita com o apelido digitado e envia o apelido e o motivo", async () => {
    const deletePlayer = vi.fn(async () => ({ walletCloseout: "done" }));
    await render(createElement(PlayerDetailScreen, { admin: fake({ player: async () => detail(), playerEntries: async () => ({ items: [], nextCursor: null }), deletePlayer }), id: ID }));
    const del = button("Excluir a conta");
    expect(del.disabled).toBe(true);
    await type("#confirma", "Ann");
    expect(del.disabled).toBe(true);
    await type("#confirma", "Ana");
    expect(del.disabled).toBe(false);
    await click(del);
    expect(deletePlayer).toHaveBeenCalledWith(ID, "Ana", "pedido do titular");
  });

  it("admin 27 e 28: o ajuste mostra a prévia, desliga com a recusa e envia com a Idempotency-Key", async () => {
    const adjustPlayer = vi.fn(async () => ({ asset: "cash", ticker: null, delta: 1000, price: null, after: 11_000 }));
    await render(createElement(PlayerDetailScreen, { admin: fake({ player: async () => detail(), playerEntries: async () => ({ items: [], nextCursor: null }), adjustPlayer }), id: ID }));
    await click(button("Debitar"));
    await type("#aj-valor", "50");
    await type("#motivo-ajuste", "débito de teste");
    expect(text()).toContain("Só há R$ 20,00 de caixa livre.");
    expect(button("Aplicar o ajuste").disabled).toBe(true);
    await type("#aj-valor", "10");
    expect(text()).toContain("Caixa: R$ 100,00 → R$ 90,00");
    expect(button("Aplicar o ajuste").disabled).toBe(false);
    await click(button("Aplicar o ajuste"));
    expect(adjustPlayer).toHaveBeenCalledTimes(1);
    const [id, body, key] = adjustPlayer.mock.calls[0] as unknown as [string, object, string];
    expect(id).toBe(ID);
    expect(body).toEqual({ asset: "cash", delta: -1000, reason: "débito de teste" });
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("auditoria de negócios (tela)", () => {
  it("manda o par e o período em UTC, mostra bot marcado, casa e conta excluída e páginas com cursor", async () => {
    const trades = vi
      .fn()
      .mockResolvedValueOnce({
        trades: [
          { id: 2, at: "2027-04-06T18:00:00.000Z", ticker: "CAP3", quantity: 3, price: 931, value: 2793, inAuction: false, buyer: { kind: "player", id: ID, label: "Ana" }, seller: { kind: "bot", id: "bot:12", label: "bot momentum #12" } },
          { id: 1, at: "2027-04-06T17:00:00.000Z", ticker: "CAP3", quantity: 50, price: 900, value: 45_000, inAuction: true, buyer: { kind: "house", id: null, label: "casa" }, seller: { kind: "deleted", id: ID, label: "conta excluída" } },
        ],
        nextCursor: "cursor-1",
      })
      .mockResolvedValueOnce({ trades: [], nextCursor: null });
    await render(createElement(AuditScreen, { admin: fake({ trades }) }));
    await type("#f-par-a", ID);
    await type("#f-par-b", "bot:12");
    await type("#f-clube", "cap3");
    await type("#f-de", "2027-04-06T12:00");
    await click(button("Buscar negócios"));
    expect(trades).toHaveBeenCalledWith({ pair: `${ID},bot:12`, club: "CAP3", from: "2027-04-06T15:00:00.000Z" });
    expect(text()).toContain("bot momentum #12");
    expect(text()).toContain("conta excluída");
    expect(text()).toContain("· leilão");
    await click(button("Mostrar mais"));
    expect(trades).toHaveBeenLastCalledWith({ pair: `${ID},bot:12`, club: "CAP3", from: "2027-04-06T15:00:00.000Z", cursor: "cursor-1" });
  });

  it("o horário digitado é o de Brasília", () => {
    expect(brasiliaToIso("2027-04-06T12:00")).toBe("2027-04-06T15:00:00.000Z");
    expect(brasiliaToIso("")).toBeUndefined();
  });
});

describe("bots (tela)", () => {
  const view = {
    profiles: [
      { profile: "momentum", active: 25, inactive: 0, bots: [{ id: 1, active: true, equity: 10_000_000, hasWallet: true }] },
      { profile: "dividendos", active: 10, inactive: 5, bots: [] },
      ...["torcedor", "aleatorio", "trader", "captura", "analista", "concentrador", "antecipador"].map((profile) => ({ profile, active: 0, inactive: 0, bots: [] })),
    ],
    botsInRankings: false,
  };

  it("admin 29: descreve o que acontece ao desligar e ao ligar (religa os desligados antes de criar)", () => {
    expect(describeChange({ active: 25, inactive: 0 }, 10)).toMatch(/Desliga 15/);
    expect(describeChange({ active: 10, inactive: 5 }, 12)).toMatch(/Religa 2 desligados/);
    expect(describeChange({ active: 10, inactive: 5 }, 20)).toMatch(/Religa 5 desligados.*cria 5 novos/);
    expect(describeChange({ active: 3, inactive: 0 }, 3)).toBe("Sem mudança.");
  });

  it("manda só os perfis que mudam e a chave dos bots nos rankings vai pela temporada", async () => {
    const updateBots = vi.fn(async () => ({ turnedOn: [], turnedOff: [], created: [] }));
    const patchSeason = vi.fn(async () => ({}));
    await render(createElement(BotsScreen, { admin: fake({ bots: async () => view, updateBots, patchSeason }), seasonId: 7 }));
    expect(button("Aplicar").disabled).toBe(true);
    await type("#bots-momentum", "10");
    await type("#bots-dividendos", "10"); // sem mudança: não entra
    expect(text()).toContain("Desliga 15");
    await click(button("Aplicar"));
    expect(updateBots).toHaveBeenCalledWith({ counts: { momentum: 10 } });
    await click(button("Ligar bots nos rankings"));
    expect(patchSeason).toHaveBeenCalledWith(7, { botsInRankings: true });
  });
});
