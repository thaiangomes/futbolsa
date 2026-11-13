// @vitest-environment jsdom
import type { WalletView } from "@futbolsa/contracts";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { useDom } from "../../../test-support/dom";
import { SeasonNotice } from "../wallet/season-notice";
import { HistoryCard, seasonReturnBp } from "./history-card";

describe("histórico e avisos do fim da temporada", () => {
  const dom = useDom();

  it("conta 15: o histórico mostra 2027 com R$ 163.400,00, +63,40% e 2º, e as posições mensais", async () => {
    expect(seasonReturnBp(16_340_000, 10_000_000)).toBe(6340);
    await dom.render(createElement(HistoryCard, { history: { seasons: [{ year: 2027, finalEquity: 16_340_000, base: 10_000_000, position: 2, months: [{ month: "2027-12", position: 1 }] }] } }));
    const row = dom.$("[data-testid=temporada]").textContent!;
    expect(row).toContain("R$ 163.400,00");
    expect(row).toContain("+63,40%");
    expect(row).toContain("2º");
    expect(row).toContain("dez/2027: 1º");
  });

  it("conta 15: bloqueado aparece sem posição", async () => {
    await dom.render(createElement(HistoryCard, { history: { seasons: [{ year: 2027, finalEquity: 9_000_000, base: 10_000_000, position: null, months: [] }] } }));
    expect(dom.$("[data-testid=temporada]").textContent).toContain("—");
  });

  const view = (extra: Partial<WalletView>) => ({ receivable: 0, buybackClosed: false, ...extra }) as WalletView;

  it("carteira 21: negociação encerrada mostra a recompra a receber", async () => {
    await dom.render(createElement(SeasonNotice, { view: view({ buybackClosed: true, receivable: 7_092_000 }) }));
    expect(dom.$("[data-testid=aviso-recompra-receber]").textContent).toContain("R$ 70.920,00");
  });

  it("conta 17: temporada encerrada avisa quando abre o IPO seguinte", async () => {
    await dom.render(createElement(SeasonNotice, { view: view({ between: { closedYear: 2027, nextIpoOpensAt: "2028-03-01T13:00:00.000Z" } }) }));
    const text = dom.$("[data-testid=aviso-temporada-encerrada]").textContent!;
    expect(text).toContain("Temporada 2027 encerrada");
    expect(text).toContain("IPO de 2028 abre em");
  });
});
