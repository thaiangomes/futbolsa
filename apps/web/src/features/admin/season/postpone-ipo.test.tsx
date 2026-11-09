// @vitest-environment jsdom
import { IPO_ERROR_MESSAGES, type SeasonView } from "@futbolsa/contracts";
import { ipoDates, postponeClose } from "@futbolsa/engine";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../lib/api";
import { useDom } from "../../../test-support/dom";
import type { AdminApi } from "../api";
import { ACTION_LABELS } from "../forms";
import { SeasonScreen } from "../season-screen";
import { brasiliaInputToIso, tradingOpensAfter } from "./dates";
import { PostponeIpo } from "./postpone-ipo";

/** O exemplo da especificação: primeiro jogo em 2027-04-11 às 16h, abre 03-28 às 16h, fecha 04-04 às 16h, negociação 04-05 às 10h. */
const open: SeasonView = {
  id: 3, year: 2027, status: "ipo_open", offerSize: 3000, firstKickoff: "2027-04-11T19:00:00.000Z",
  ipoOpensAt: "2027-03-28T19:00:00.000Z", ipoClosesAt: "2027-04-04T19:00:00.000Z", tradingOpensAt: "2027-04-05T13:00:00.000Z", suspendedReason: null,
};
const postponed: SeasonView = { ...open, ipoClosesAt: "2027-04-06T19:00:00.000Z", tradingOpensAt: "2027-04-07T13:00:00.000Z" };
const fake = (overrides: Partial<Record<keyof AdminApi, unknown>>) => overrides as unknown as AdminApi;

describe("datas do adiamento do IPO", () => {
  it("o campo de data e hora é de Brasília: 16h vira 19h UTC", () => {
    expect(brasiliaInputToIso("2027-04-06T16:00")).toBe("2027-04-06T19:00:00.000Z");
    expect(brasiliaInputToIso("2027-04-06T22:30")).toBe("2027-04-07T01:30:00.000Z");
    expect(brasiliaInputToIso("")).toBeNull();
    expect(brasiliaInputToIso("2027-02-31T10:00")).toBeNull();
    expect(brasiliaInputToIso("2027-13-01T10:00")).toBeNull();
    expect(brasiliaInputToIso("06/04/2027 16:00")).toBeNull();
  });

  it("ipo 28: fechando em 2027-04-06 às 16h, a negociação abre em 2027-04-07 às 10h", () => {
    expect(tradingOpensAfter("2027-04-06T19:00:00.000Z")).toBe("2027-04-07T13:00:00.000Z");
  });

  it("a abertura calculada na tela é a mesma de postponeClose do motor, inclusive perto da meia-noite de Brasília", () => {
    const dates = ipoDates(Date.parse("2027-04-11T19:00:00.000Z"));
    const now = dates.opensAt + 1000;
    for (const local of ["2027-04-04T16:00", "2027-04-04T23:59", "2027-04-05T00:00", "2027-04-05T00:01", "2027-04-06T16:00", "2027-04-30T09:59", "2027-05-01T10:00", "2027-12-31T23:30"]) {
      const closes = Date.parse(brasiliaInputToIso(local)!);
      expect(Date.parse(tradingOpensAfter(new Date(closes).toISOString())), local).toBe(postponeClose(dates, closes, now).tradingOpensAt);
    }
  });

  it("o nome em português da ação season.ipo.postpone está no registro", () => {
    expect(ACTION_LABELS["season.ipo.postpone"]).toBe("Fechamento do IPO adiado");
  });
});

describe("adiar o fechamento do IPO (tela)", () => {
  const dom = useDom();
  const cardFor = (admin: AdminApi, season: SeasonView = open, onDone = async () => undefined) =>
    dom.render(createElement(PostponeIpo, { season, admin, onDone }));

  it("só aparece com a temporada em ipo_open", async () => {
    for (const status of ["preparing", "ipo_closed", "trading"] as const) {
      await cardFor(fake({}), { ...open, status });
      expect(dom.$("[data-testid=adiar-ipo]")).toBeNull();
    }
    await cardFor(fake({}));
    expect(dom.$("[data-testid=adiar-ipo]")).not.toBeNull();
  });

  it("mostra as datas de agora e, ao digitar o novo fechamento, a nova abertura da negociação", async () => {
    await cardFor(fake({}));
    const text = () => dom.$("[data-testid=adiar-ipo]").textContent!;
    expect(text()).toContain("04/04/2027");
    expect(text()).toContain("05/04/2027");
    expect(dom.$("[data-testid=nova-abertura]")).toBeNull();
    await dom.type("#novo-fechamento", "2027-04-06T16:00");
    const nova = dom.$("[data-testid=nova-abertura]").textContent!;
    expect(nova).toContain("07/04/2027");
    expect(nova).toMatch(/10:00/);
  });

  it("ipo 28: manda o novo fechamento em ISO com fuso (Brasília), sem motivo se ele ficou vazio, e recarrega a temporada", async () => {
    const patchSeason = vi.fn(async () => postponed);
    const onDone = vi.fn(async () => undefined);
    await cardFor(fake({ patchSeason }), open, onDone);
    expect(dom.button("Adiar o fechamento").disabled).toBe(true);
    await dom.type("#novo-fechamento", "2027-04-06T16:00");
    await dom.click(dom.button("Adiar o fechamento"));
    expect(patchSeason).toHaveBeenCalledWith(3, { ipoClosesAt: "2027-04-06T19:00:00.000Z" });
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("o motivo é opcional, mas vai junto quando preenchido; motivo curto demais trava o botão", async () => {
    const patchSeason = vi.fn(async () => postponed);
    await cardFor(fake({ patchSeason }));
    await dom.type("#novo-fechamento", "2027-04-06T16:00");
    await dom.type("#motivo-adiar", "ab");
    expect(dom.button("Adiar o fechamento").disabled).toBe(true);
    await dom.type("#motivo-adiar", "feriado no estádio");
    await dom.click(dom.button("Adiar o fechamento"));
    expect(patchSeason).toHaveBeenCalledWith(3, { ipoClosesAt: "2027-04-06T19:00:00.000Z", reason: "feriado no estádio" });
  });

  it("depois de adiar mostra o fechamento e a abertura da negociação que a API gravou", async () => {
    const patchSeason = vi.fn(async () => postponed);
    await cardFor(fake({ patchSeason }));
    await dom.type("#novo-fechamento", "2027-04-06T16:00");
    await dom.click(dom.button("Adiar o fechamento"));
    const done = dom.$("[data-testid=adiado]").textContent!;
    expect(done).toContain("06/04/2027");
    expect(done).toContain("07/04/2027");
  });

  it("ipo 28: antecipar é recusado pela API e a tela mostra a mensagem do código ipo_close_earlier", async () => {
    const patchSeason = vi.fn(async () => {
      throw new ApiError(422, "ipo_close_earlier", "TEXTO DO SERVIDOR");
    });
    await cardFor(fake({ patchSeason }));
    await dom.type("#novo-fechamento", "2027-04-02T16:00");
    expect(dom.$("[data-testid=nova-abertura]")).toBeNull();
    await dom.click(dom.button("Adiar o fechamento"));
    expect(patchSeason).toHaveBeenCalledWith(3, { ipoClosesAt: "2027-04-02T19:00:00.000Z" });
    expect(dom.$("[role=alert]").textContent).toBe(IPO_ERROR_MESSAGES.ipo_close_earlier);
    expect(dom.$("[data-testid=adiado]")).toBeNull();
  });

  it("adiar depois do fechamento (ipo_closed) mostra a mensagem do código", async () => {
    const patchSeason = vi.fn(async () => {
      throw new ApiError(409, "ipo_closed", "x");
    });
    await cardFor(fake({ patchSeason }));
    await dom.type("#novo-fechamento", "2027-04-06T16:00");
    await dom.click(dom.button("Adiar o fechamento"));
    expect(dom.$("[role=alert]").textContent).toBe(IPO_ERROR_MESSAGES.ipo_closed);
  });
});

describe("preparar a temporada: o cartão de adiar entra na tela", () => {
  const dom = useDom();
  const rules = { aPerPoint: 10, bPerPoint: 5, aPlacement: [500], promotionPerShare: 200, promotionSlots: 4, buybackMultipleBp: 15000, lockedAt: "2027-03-28T19:00:00.000Z" };
  const admin = (season: SeasonView) =>
    fake({ currentSeason: async () => ({ season, clubs: [] }), knownClubs: async () => ({ clubs: [] }), rules: async () => ({ rules, cups: [] }) });

  it("com o IPO aberto, a tela de preparar a temporada tem o cartão", async () => {
    await dom.render(createElement(SeasonScreen, { admin: admin(open) }));
    expect(dom.$("[data-testid=adiar-ipo]")).not.toBeNull();
    expect(dom.text()).toContain("Adiar o fechamento do IPO");
  });

  it("em preparação, não tem", async () => {
    await dom.render(createElement(SeasonScreen, { admin: admin({ ...open, status: "preparing", ipoClosesAt: null }) }));
    expect(dom.$("[data-testid=adiar-ipo]")).toBeNull();
  });
});
