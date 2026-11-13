// @vitest-environment jsdom
import { IPO_BLOCKER_MESSAGES, type Overview } from "@futbolsa/contracts";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { useDom } from "../../test-support/dom";
import type { AdminApi } from "./api";
import { OverviewScreen } from "./overview-screen";

const calm: Overview = {
  pendingMatches: 0,
  standingsNotConfirmed: [],
  cupsNotConfirmed: [],
  suspendedClubs: [],
  marketSuspended: false,
  ipoBlockers: [],
  ipoSettlementFailures: [],
  pendingPayouts: 0,
  settlingPayouts: 0,
  correctionToApply: false,
  openFraudCases: 0,
};
const apiWith = (overview: Overview) => ({ overview: async () => overview }) as unknown as AdminApi;

describe("visão geral do admin: IPO", () => {
  const dom = useDom();
  const show = async (admin: AdminApi) => {
    await dom.render(createElement(OverviewScreen, { admin }));
    await dom.settle();
    await dom.settle();
  };

  it("sem nada do IPO a mostrar, não aparece item do IPO", async () => {
    await show(apiWith(calm));
    expect(dom.text()).not.toContain("O IPO não abriu");
    expect(dom.text()).not.toContain("liquidação do IPO");
  });

  it("proposta 6: o IPO que não abriu mostra o que falta, com a mensagem de cada motivo", async () => {
    await show(apiWith({ ...calm, ipoBlockers: ["offer_size_missing", "cups_not_confirmed"] }));
    expect(dom.text()).toContain(IPO_BLOCKER_MESSAGES.offer_size_missing);
    expect(dom.text()).toContain(IPO_BLOCKER_MESSAGES.cups_not_confirmed);
  });

  it("a liquidação com erro mostra o clube e a mensagem, e avisa que a negociação espera", async () => {
    await show(apiWith({ ...calm, ipoSettlementFailures: [{ ticker: "FLA3", error: "reserva não cobre o pagamento" }] }));
    const text = dom.text();
    expect(text).toContain("A liquidação do IPO está com erro em FLA3 (reserva não cobre o pagamento)");
    expect(text).toContain("só abre depois de liquidar todos os clubes");
  });
});
