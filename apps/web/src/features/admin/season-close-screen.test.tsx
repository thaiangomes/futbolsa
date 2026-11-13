// @vitest-environment jsdom
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { useDom } from "../../test-support/dom";
import type { AdminApi } from "./api";
import { SeasonCloseScreen } from "./season-close-screen";

const base = {
  seasonId: 7,
  year: 2027,
  status: "trading_ended" as const,
  summary: { wallets: 3, totalCash: 30_000_000, leader: { nickname: "ana", equity: 16_340_000 } },
};
const fakeAdmin = (preview: object, close = vi.fn(async () => ({ seasonId: 7, closedAt: "2027-12-10T15:00:00.000Z", wallets: 3, results: 2 }))) =>
  ({ currentSeason: async () => ({ season: { id: 7 }, clubs: [] }), seasonClose: async () => preview, closeSeason: close }) as unknown as AdminApi;

describe("encerrar a temporada (tela)", () => {
  const dom = useDom();

  it("admin 21: mostra o que falta com o link e não deixa encerrar", async () => {
    const preview = { ...base, canClose: false, blockers: [{ code: "payouts_pending", count: 2, text: "2 pagamentos aguardam aprovação", link: "/admin/pagamentos" }] };
    await dom.render(createElement(SeasonCloseScreen, { admin: fakeAdmin(preview) }));
    await dom.settle();
    expect(dom.$("[data-testid=o-que-falta]").textContent).toContain("2 pagamentos aguardam aprovação");
    expect(dom.$("[data-testid=o-que-falta] a").getAttribute("href")).toBe("/admin/pagamentos");
    expect(dom.$<HTMLButtonElement>("button[type=submit]").disabled).toBe(true);
  });

  it("admin 38: só encerra digitando o ano certo", async () => {
    const close = vi.fn(async () => ({ seasonId: 7, closedAt: "2027-12-10T15:00:00.000Z", wallets: 3, results: 2 }));
    await dom.render(createElement(SeasonCloseScreen, { admin: fakeAdmin({ ...base, canClose: true, blockers: [] }, close) }));
    await dom.settle();
    expect(dom.$("[data-testid=nada-falta]")).not.toBeNull();
    const submit = () => dom.$<HTMLButtonElement>("button[type=submit]");
    expect(submit().disabled).toBe(true);
    await dom.type("#ano", "2026");
    expect(submit().disabled).toBe(true);
    await dom.type("#ano", "2027");
    expect(submit().disabled).toBe(false);
    await dom.click(submit());
    await dom.settle();
    expect(close).toHaveBeenCalledWith(7, 2027);
    expect(dom.$("[data-testid=encerrada]").textContent).toContain("3 carteiras");
  });
});
