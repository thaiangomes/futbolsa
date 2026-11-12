// @vitest-environment jsdom
import type { EquityResponse, Snapshot } from "@futbolsa/contracts";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { useDom } from "../../../test-support/dom";
import { equitySeries } from "../equity/equity-series";
import type { PortfolioApi } from "../api";
import { ProfileSnapshot, SnapshotCard } from "./snapshot-card";

// T16 e T14: a foto mensal no perfil e a série do gráfico de patrimônio (Carteira e gráficos 29 a 32 e 41).

const snapshot: Snapshot = { month: "2027-05", slices: [{ key: "FLA3", name: "Flamengo", permille: 475 }, { key: "cash", name: null, permille: 525 }] };

describe("foto mensal no perfil", () => {
  const dom = useDom();

  it("carteira 30: mostra 47,5% e 52,5% e o mês, sem quantidade, preço nem valor", async () => {
    await dom.render(createElement(SnapshotCard, { snapshot }));
    expect(dom.$$("[data-testid=fatia]").map((f) => f.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("47,5%"), expect.stringContaining("52,5%")]));
    expect(dom.$("[data-testid=foto-mes]").textContent).toBe("maio de 2027");
    expect(dom.text()).not.toMatch(/R\$|\d ações/);
  });

  it("carteira 31: sem foto, o texto diz que ainda não há", async () => {
    await dom.render(createElement(SnapshotCard, { snapshot: null }));
    expect(dom.$("[data-testid=sem-foto]").textContent).toContain("Ainda não há foto");
  });

  it("carteira 41: caixa negativo vira fatia negativa em destaque", async () => {
    await dom.render(createElement(SnapshotCard, { snapshot: { month: "2027-04", slices: [{ key: "PAL3", name: "Palmeiras", permille: 1333 }, { key: "cash", name: null, permille: -333 }] } }));
    const cash = dom.$("[data-testid=fatia][data-key=cash]");
    expect(cash.textContent).toContain("−33,3%");
    expect(cash.innerHTML).toContain("neg-cash");
  });

  it("o perfil lê GET /players/:nickname e mostra a foto; a falha da rede some em silêncio", async () => {
    const api = { player: vi.fn(async () => ({ nickname: "anagol", snapshot })) } as unknown as PortfolioApi;
    await dom.render(createElement(ProfileSnapshot, { nickname: "anagol", api }));
    await dom.settle();
    await dom.settle();
    expect(api.player).toHaveBeenCalledWith("anagol");
    expect(dom.$("[data-testid=foto-carteira]")).not.toBeNull();
  });
});

describe("série do gráfico de patrimônio", () => {
  const data: EquityResponse = {
    base: 10_000_000,
    startedAt: "2027-04-01T13:00:00.000Z",
    points: [
      { day: "2027-04-01", equity: 10_000_000 },
      { day: "2027-04-02", equity: 10_250_000 },
    ],
    current: { at: "2027-04-03T15:00:00.000Z", equity: 10_300_000 },
    dividendDays: [{ day: "2027-04-02", total: 36_000 }, { day: "2027-04-03", total: 1000 }],
  };

  it("carteira 29: começa em R$ 100.000,00, um ponto por dia, valor atual no fim e a linha de R$ 100.000,00", () => {
    const s = equitySeries(data);
    expect(s.base).toBe(100_000);
    expect(s.points.map((p) => p.value)).toEqual([100_000, 100_000, 102_500, 103_000]);
    expect(s.points.map((p) => p.time)).toEqual([...s.points.map((p) => p.time)].sort((a, b) => a - b));
    expect(s.points[0]!.time).toBe(Date.parse("2027-04-01T13:00:00Z") / 1000);
  });

  it("carteira 29: marcador nos dias com dividendo, com o total; o dia ainda aberto fica no ponto atual", () => {
    const s = equitySeries(data);
    expect(s.markers.map((m) => [m.text, m.time])).toEqual([
      ["R$ 360,00", Date.parse("2027-04-02T23:59:00-03:00") / 1000],
      ["R$ 10,00", Date.parse("2027-04-03T15:00:00Z") / 1000],
    ]);
  });

  it("sem dias fechados, só o ponto de entrada e o atual", () => {
    const s = equitySeries({ ...data, points: [], dividendDays: [] });
    expect(s.points).toHaveLength(2);
    expect(s.markers).toEqual([]);
  });
});
