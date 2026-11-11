// @vitest-environment jsdom
import type { PublicTrade } from "@futbolsa/contracts";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { useDom } from "../../test-support/dom";
import { BookPanel } from "./book-panel";
import type { ClubState } from "./club-state";
import { auctionNotice, formatChange } from "./format";
import { MarketStatus } from "./market-status";
import { PriceHeader } from "./price-header";
import { TradesPanel } from "./trades-panel";

// W2 do Plano do livro de ofertas e formador: livro, últimos negócios, preço e variação e os avisos de estado.

const level = (price: number, quantity: number, orders = 1) => ({ price, quantity, orders });
const state = (over: Partial<ClubState> = {}): ClubState => ({
  ticker: "FLA3",
  seq: 1,
  price: { displayed: 4430, open: 4300, changeBp: 302 },
  matchMode: false,
  auction: null,
  market: { state: "open", opensAt: "2027-04-05T13:00:00.000Z", reason: null },
  bids: [level(4450, 100), level(4420, 90, 2)],
  asks: [level(4460, 120, 3), level(4480, 75, 2)],
  trades: [],
  me: null,
  ...over,
});

describe("formatação", () => {
  it("livro 20: variação com sinal e duas casas", () => {
    expect(formatChange(500)).toBe("▲ +5,00%");
    expect(formatChange(-302)).toBe("▼ −3,02%");
    expect(formatChange(0)).toBe("0,00%");
  });

  it("o aviso de leilão: até quando, ou parado pela suspensão", () => {
    expect(auctionNotice(null)).toBeNull();
    expect(auctionNotice({ until: "2027-04-05T18:40:00.000Z" })).toBe("Em leilão até 15h40");
    expect(auctionNotice({ until: null })).toBe("Leilão parado pela suspensão");
  });
});

describe("livro e negócios", () => {
  const dom = useDom();

  it("livro 18: mostra os níveis com quantidade e número de ordens, sem nenhum nome, e destaca só a minha ordem", async () => {
    const s = state();
    await dom.render(createElement(BookPanel, { bids: s.bids, asks: s.asks, mine: [{ side: "buy", limitPrice: 4450 }] }));
    const bids = dom.$$("[data-testid=nivel-compra]");
    const asks = dom.$$("[data-testid=nivel-venda]");
    expect(bids).toHaveLength(2);
    expect(asks).toHaveLength(2);
    expect(bids[0]!.textContent).toContain("44,50");
    expect(bids[0]!.textContent).toContain("100");
    expect(bids[0]!.getAttribute("data-mine")).toBe("true");
    expect(bids[1]!.getAttribute("data-mine")).toBe("false");
    expect(bids[0]!.className).toContain("bk-mine");
    expect(asks[0]!.getAttribute("data-mine")).toBe("false");
    // spread entre a melhor venda e a melhor compra
    expect(dom.$("[data-testid=spread]").textContent).toBe("R$ 0,10");
  });

  it("sem a minha ordem nada fica destacado (o outro jogador vê a mesma tela sem destaque)", async () => {
    const s = state();
    await dom.render(createElement(BookPanel, { bids: s.bids, asks: s.asks }));
    expect(dom.$$("[data-mine=true]")).toHaveLength(0);
  });

  it("o livro vazio não quebra e não mostra spread", async () => {
    await dom.render(createElement(BookPanel, { bids: [], asks: [] }));
    expect(dom.$("[data-testid=spread]")).toBeNull();
  });

  it("livro 19: os negócios aparecem do mais recente para o mais antigo, com hora, preço e quantidade, sem contraparte", async () => {
    const trades: PublicTrade[] = [
      { id: 3, at: "2027-04-05T19:14:00.000Z", price: 4430, quantity: 50 },
      { id: 2, at: "2027-04-05T19:09:00.000Z", price: 4410, quantity: 7 },
    ];
    await dom.render(createElement(TradesPanel, { trades }));
    const rows = dom.$$("[data-testid=negocio]");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("16:14");
    expect(rows[0]!.textContent).toContain("R$ 44,30");
    expect(rows[0]!.textContent).toContain("50");
    expect(rows[0]!.querySelector(".up")).not.toBeNull(); // subiu em relação ao anterior
    expect(dom.text()).toContain("contraparte");
  });
});

describe("preço e avisos", () => {
  const dom = useDom();

  it("livro 20: preço exibido, variação e a base das 0h", async () => {
    await dom.render(createElement(PriceHeader, { state: state() }));
    expect(dom.$("[data-testid=preco]").textContent).toBe("R$ 44,30");
    expect(dom.$("[data-testid=variacao]").textContent).toBe("▲ +3,02%");
    expect(dom.text()).toContain("R$ 43,00 às 0h de Brasília");
    expect(dom.$("[data-testid=chip-jogo]")).toBeNull();
  });

  it("livro 27: \"em jogo agora\" no cabeçalho e no aviso enquanto o modo de jogo durar", async () => {
    await dom.render(createElement("div", null, createElement(PriceHeader, { state: state({ matchMode: true }) }), createElement(MarketStatus, { state: state({ matchMode: true }) })));
    expect(dom.$("[data-testid=chip-jogo]").textContent).toContain("Em jogo agora");
    expect(dom.$("[data-testid=aviso-jogo]").textContent).toContain("Em jogo agora");
  });

  it("antes da estreia: negociação abre às 10h", async () => {
    await dom.render(createElement(MarketStatus, { state: state({ market: { state: "not_open", opensAt: "2027-04-05T13:00:00.000Z", reason: null } }) }));
    expect(dom.$("[data-testid=aviso-abertura]").textContent).toBe("A negociação abre às 10h00.");
  });

  it("suspenso: mostra o motivo e que dá para cancelar; encerrada: avisa o fim da temporada", async () => {
    await dom.render(createElement(MarketStatus, { state: state({ market: { state: "suspended", opensAt: null, reason: "Placar errado" } }) }));
    expect(dom.$("[data-testid=aviso-suspenso]").textContent).toContain("Placar errado");
    expect(dom.$("[data-testid=aviso-suspenso]").textContent).toContain("cancelar");
    await dom.render(createElement(MarketStatus, { state: state({ market: { state: "ended", opensAt: null, reason: null } }) }));
    expect(dom.$("[data-testid=aviso-encerrada]")).not.toBeNull();
  });

  it("em leilão até 15h40, no cabeçalho e no aviso, no mesmo padrão do aviso de jogo; parado pela suspensão aparece como suspenso", async () => {
    const leilao = state({ auction: { until: "2027-04-05T18:40:00.000Z" } });
    await dom.render(createElement("div", null, createElement(PriceHeader, { state: leilao }), createElement(MarketStatus, { state: leilao })));
    expect(dom.$("[data-testid=chip-leilao]").textContent).toContain("Em leilão até 15h40");
    expect(dom.$("[data-testid=aviso-leilao]").textContent).toContain("preço único");
    const parado = state({ auction: { until: null }, market: { state: "suspended", opensAt: null, reason: "Manutenção" } });
    await dom.render(createElement(MarketStatus, { state: parado }));
    expect(dom.$("[data-testid=aviso-leilao]")).toBeNull();
    expect(dom.$("[data-testid=aviso-suspenso]")).not.toBeNull();
  });
});
