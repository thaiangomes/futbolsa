// @vitest-environment jsdom
import type { IpoClubResult } from "@futbolsa/contracts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { useDom } from "../../../test-support/dom";
import { OfferPeriod } from "../offer-period/offer-period";
import { ResultsScreen } from "../results/results-screen";
import { FLA3, NOW_OPEN, fakeApi, openOverview, PAL3 } from "../test-fixtures";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../styles/futbolsa.css"), "utf8");

/** O texto dos blocos `@media (max-width:<px>px){...}` do CSS do site (com as chaves de dentro). */
function mediaBlocks(width: number): string[] {
  const blocks: string[] = [];
  const start = `@media (max-width:${width}px){`;
  let from = css.indexOf(start);
  while (from !== -1) {
    let depth = 1;
    let i = from + start.length;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    blocks.push(css.slice(from + start.length, i - 1).replace(/\s+/g, " "));
    from = css.indexOf(start, i);
  }
  return blocks;
}

const MY_BID = { quantity: 1500, maxPrice: 4000, reserved: 6_000_000, updatedAt: "2027-03-30T15:00:00.000Z" };
const RESULT: IpoClubResult = {
  ticker: "FLA3", name: "Flamengo", cutPrice: 3500, demandAtCut: 4500, ratio: { num: 2, den: 3 }, leftoverShares: 0, lotShares: 600,
  myAllocation: { shares: 1000, paid: 3_500_000, refunded: 2_500_000 },
};

/**
 * O site só tem CSS responsivo (não tem mecanismo de largura em JavaScript): o que o celular de 390 px
 * usa é a estrutura do HTML (cartões empilhados, sem tabela larga, formulário em coluna, alvos de toque
 * grandes) mais as regras `@media (max-width:760px)` do `futbolsa.css`. Estes testes conferem as duas coisas.
 */
describe("IPO no celular (390 px): estrutura das telas", () => {
  const dom = useDom();

  async function offerPeriodWithOpenForm() {
    const overview = openOverview({ clubs: [{ ...FLA3, myBid: MY_BID }, PAL3], cash: { total: 10_000_000, reserved: 6_000_000, free: 4_000_000 } });
    await dom.render(createElement(OfferPeriod, { overview, api: fakeApi({}), now: NOW_OPEN, onOverview: () => undefined, onStale: () => undefined }));
    await dom.click(dom.button("Editar", dom.$('[data-ticker="FLA3"]')));
  }

  it("o período de ofertas é uma lista de cartões, um por clube, sem tabela larga", async () => {
    await offerPeriodWithOpenForm();
    const list = dom.$("ul.ipo-list");
    expect(list.querySelectorAll(":scope > li.ipo-card")).toHaveLength(2);
    expect(dom.$$("table, .tbl, .scroll-x")).toHaveLength(0);
  });

  it("cada cartão traz faixa, a conta das copas e a oferta empilhados, com rótulo em cada número", async () => {
    await offerPeriodWithOpenForm();
    const card = dom.$('[data-ticker="FLA3"]');
    for (const part of [".ipo-id", ".ipo-band", ".ipo-mine", ".ipo-actions"]) expect(card.querySelector(`:scope > ${part}`), part).not.toBeNull();
    for (const cell of card.querySelectorAll(".ipo-cell")) {
      expect(cell.querySelector(".ipo-k")?.textContent, "rótulo").toBeTruthy();
      expect(cell.querySelector(".ipo-v")?.textContent, "valor").toBeTruthy();
    }
  });

  it("o formulário é uma coluna de campos com teclado numérico e alvos de toque grandes", async () => {
    await offerPeriodWithOpenForm();
    const form = dom.$("form.ipo-form");
    const fields = [...form.querySelectorAll(":scope > .field")];
    expect(fields).toHaveLength(2);
    expect(dom.$<HTMLInputElement>("#qtd-FLA3").inputMode).toBe("numeric");
    expect(dom.$<HTMLInputElement>("#preco-FLA3").inputMode).toBe("decimal");
    // todo botão e campo de ação tem a classe de alvo de toque (min-height de 44 px no CSS)
    const actionable = [...dom.$$("[data-ticker] button"), ...form.querySelectorAll("input")];
    expect(actionable.length).toBeGreaterThan(4);
    for (const el of actionable) expect(el.classList.contains("ipo-touch"), el.outerHTML).toBe(true);
  });

  it("o resultado do rateio também é uma lista de cartões, sem tabela", async () => {
    await dom.render(createElement(ResultsScreen, { clubs: [RESULT] }));
    expect(dom.$$("ul.ipo-list > li.ipo-card.ipo-result")).toHaveLength(1);
    expect(dom.$$("table, .tbl, .scroll-x")).toHaveLength(0);
    expect(dom.$$(".ipo-cell .ipo-k").length).toBeGreaterThanOrEqual(7);
  });
});

describe("IPO no celular (390 px): regras de CSS", () => {
  const phone = () => mediaBlocks(760).join(" ");

  it("a faixa de 760 px para baixo cobre o celular de 390 px", () => {
    expect(mediaBlocks(760).length).toBeGreaterThan(0);
    expect(390).toBeLessThanOrEqual(760);
  });

  it("os cartões e o formulário viram uma coluna só", () => {
    expect(phone()).toMatch(/\.ipo-card\{[^}]*grid-template-columns:minmax\(0,1fr\)/);
    expect(phone()).toMatch(/\.ipo-form\{[^}]*grid-template-columns:minmax\(0,1fr\)/);
    expect(phone()).toMatch(/\.ipo-result\{[^}]*grid-template-columns:minmax\(0,1fr\)/);
  });

  it("os números ficam em duas colunas, sem estourar a largura", () => {
    expect(phone()).toMatch(/\.ipo-cells[^{]*\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
    expect(phone()).toMatch(/\.ipo-v\{[^}]*overflow-wrap:anywhere/);
  });

  it("botões e campos têm alvo de toque de pelo menos 44 px, e o texto dos campos 16 px (o iOS não dá zoom)", () => {
    expect(phone()).toMatch(/\.ipo-touch\{[^}]*min-height:44px/);
    expect(phone()).toMatch(/\.ipo-form \.input\{[^}]*font-size:16px/);
  });

  it("os botões do cartão dividem a largura", () => {
    expect(phone()).toMatch(/\.ipo-actions \.btn[^{]*\{[^}]*flex:1/);
  });
});
