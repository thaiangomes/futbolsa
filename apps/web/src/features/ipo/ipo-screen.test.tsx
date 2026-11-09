// @vitest-environment jsdom
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { useDom } from "../../test-support/dom";
import { IpoScreen } from "./ipo-screen";
import { CASH_FREE, fakeApi, NOW_OPEN, openOverview } from "./test-fixtures";

const pending = { status: "pending" as const };

describe("tela do IPO: carregar e atualizar sem recarregar", () => {
  const dom = useDom();

  it("lê a visão geral e o resultado ao abrir e mostra o período de ofertas", async () => {
    const overview = vi.fn(async () => openOverview());
    const results = vi.fn(async () => pending);
    await dom.render(createElement(IpoScreen, { api: fakeApi({ overview, results }), now: () => NOW_OPEN }));
    expect(overview).toHaveBeenCalledOnce();
    expect(results).toHaveBeenCalledOnce();
    expect(dom.$$("[data-ticker]")).toHaveLength(2);
  });

  it("assina o canal da temporada e o da conta", async () => {
    const api = fakeApi({ overview: async () => openOverview(), results: async () => pending });
    await dom.render(createElement(IpoScreen, { api, now: () => NOW_OPEN }));
    expect(dom.realtime.subscribedChannels().sort()).toEqual(["me", "season"]);
  });

  it("ipo 15: season.status (a abertura) troca a tela de espera pelas faixas, sem recarregar a página", async () => {
    let status: "preparing" | "ipo_open" = "preparing";
    const overview = vi.fn(async () =>
      status === "preparing" ? openOverview({ status: "preparing", clubs: [], cash: null, offerSize: null }) : openOverview(),
    );
    await dom.render(createElement(IpoScreen, { api: fakeApi({ overview, results: async () => pending }), now: () => NOW_OPEN }));
    expect(dom.text()).toContain("As ofertas abrem em");
    expect(dom.$$("[data-ticker]")).toHaveLength(0);
    status = "ipo_open";
    await dom.realtime.emit("season", "season.status", { seasonId: 1, status: "ipo_open", ipoClosesAt: "2027-04-04T19:00:00.000Z", tradingOpensAt: "2027-04-05T13:00:00.000Z" });
    await dom.settle();
    expect(overview).toHaveBeenCalledTimes(2);
    expect(dom.$$("[data-ticker]")).toHaveLength(2);
  });

  it("ipo 28: o adiamento (season.status com o fechamento novo) traz a data nova", async () => {
    let closesAt = "2027-04-04T19:00:00.000Z";
    const overview = vi.fn(async () => openOverview({ closesAt, tradingOpensAt: closesAt.startsWith("2027-04-06") ? "2027-04-07T13:00:00.000Z" : "2027-04-05T13:00:00.000Z" }));
    await dom.render(createElement(IpoScreen, { api: fakeApi({ overview, results: async () => pending }), now: () => NOW_OPEN }));
    expect(dom.text()).toContain("04/04/2027");
    closesAt = "2027-04-06T19:00:00.000Z";
    await dom.realtime.emit("season", "season.status", { seasonId: 1, status: "ipo_open", ipoClosesAt: closesAt, tradingOpensAt: "2027-04-07T13:00:00.000Z" });
    await dom.settle();
    expect(dom.text()).toContain("06/04/2027");
    expect(dom.text()).toContain("07/04/2027");
    expect(dom.$("[data-testid=contagem]").textContent).toBe("5 d 4 h 0 min 0 s");
  });

  it.each(["wallet.changed", "entry.added"])("%s no canal da conta relê o caixa e as ofertas", async (type) => {
    let cash = CASH_FREE;
    const overview = vi.fn(async () => openOverview({ cash }));
    await dom.render(createElement(IpoScreen, { api: fakeApi({ overview, results: async () => pending }), now: () => NOW_OPEN }));
    expect(dom.$("[data-testid=caixa-reservado]").textContent).toContain("R$ 0,00");
    cash = { total: 10_000_000, reserved: 2_500_000, free: 7_500_000 };
    await dom.realtime.emit("me", type, {});
    await dom.settle();
    expect(overview).toHaveBeenCalledTimes(2);
    expect(dom.$("[data-testid=caixa-reservado]").textContent).toContain("R$ 25.000,00");
  });

  it("eventos de outros tipos no canal não recarregam", async () => {
    const overview = vi.fn(async () => openOverview());
    await dom.render(createElement(IpoScreen, { api: fakeApi({ overview, results: async () => pending }), now: () => NOW_OPEN }));
    await dom.realtime.emit("me", "order.updated", {});
    await dom.realtime.emit("season", "market.suspended", {});
    expect(overview).toHaveBeenCalledOnce();
  });

  it("uma rajada de eventos não empilha leituras: no máximo uma em andamento e mais uma depois", async () => {
    let release: () => void = () => undefined;
    let calls = 0;
    const overview = vi.fn(async () => {
      calls += 1;
      if (calls === 2) await new Promise<void>((resolve) => (release = resolve));
      return openOverview();
    });
    await dom.render(createElement(IpoScreen, { api: fakeApi({ overview, results: async () => pending }), now: () => NOW_OPEN }));
    await dom.realtime.emit("me", "wallet.changed", {});
    await dom.realtime.emit("me", "entry.added", {});
    await dom.realtime.emit("me", "wallet.changed", {});
    expect(overview).toHaveBeenCalledTimes(2);
    release();
    await dom.settle();
    await dom.settle();
    expect(overview).toHaveBeenCalledTimes(3);
  });

  it("falha ao ler mostra a mensagem do erro", async () => {
    const overview = vi.fn(async () => {
      throw new Error("A API não respondeu.");
    });
    await dom.render(createElement(IpoScreen, { api: fakeApi({ overview, results: async () => pending }), now: () => NOW_OPEN }));
    expect(dom.$("[role=alert]").textContent).toBe("A API não respondeu.");
  });
});
