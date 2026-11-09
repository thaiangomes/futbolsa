// @vitest-environment jsdom
import { bidReserve as engineBidReserve } from "@futbolsa/engine";
import { IPO_ERROR_MESSAGES, type IpoOverview } from "@futbolsa/contracts";
import { createElement, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../lib/api";
import { formatCents } from "../../../lib/format";
import { useDom } from "../../../test-support/dom";
import { CASH_FREE, CLOSES_AT, fakeApi, FLA3, NOW_OPEN, openOverview, PAL3 } from "../test-fixtures";
import { OfferPeriod } from "./offer-period";

const bid = { quantity: 1500, maxPrice: 4000, reserved: 6_000_000, updatedAt: "2027-03-30T15:00:00.000Z" };
const reservedCash = { total: 10_000_000, reserved: 6_000_000, free: 4_000_000 };

describe("período de ofertas (tela)", () => {
  const dom = useDom();

  /** Monta a tela guardando o estado da visão geral como a página faz. */
  async function show(overview: IpoOverview, api = fakeApi({}), now = NOW_OPEN) {
    let current = overview;
    const Host = () => {
      const [state, setState] = useState(overview);
      current = state;
      return createElement(OfferPeriod, { overview: state, api, now, onOverview: setState, onStale: () => undefined });
    };
    await dom.render(createElement(Host));
    return { overview: () => current };
  }
  const card = (ticker: string) => dom.$(`[data-ticker="${ticker}"]`);
  const openForm = async (ticker: string, label: string) => dom.click(dom.button(label, card(ticker)));

  it("ipo 15: mostra as datas, a oferta, a faixa com a conta das copas e o caixa; nada de demanda", async () => {
    await show(openOverview());
    const text = dom.text();
    expect(text).toContain("3.000 ações por clube");
    expect(text).toContain("28/03/2027");
    expect(text).toContain("04/04/2027");
    expect(text).toContain("05/04/2027");
    // contagem até o fechamento: de 2027-04-01 12h a 2027-04-04 16h = 3 d 4 h
    expect(dom.$("[data-testid=contagem]").textContent).toBe("3 d 4 h 0 min 0 s");
    const fla = card("FLA3").textContent!;
    expect(fla).toContain("Flamengo");
    expect(fla).toContain("R$ 40,00");
    expect(fla).toContain("R$ 10,55");
    expect(fla).toContain("R$ 50,55");
    expect(fla).toContain("R$ 30,33");
    expect(fla).toContain("R$ 70,77");
    expect(dom.$("[data-testid=caixa-total]").textContent).toContain("R$ 100.000,00");
    expect(dom.$("[data-testid=caixa-reservado]").textContent).toContain("R$ 0,00");
    expect(dom.$("[data-testid=caixa-livre]").textContent).toContain("R$ 100.000,00");
  });

  it("ipo 15: o texto da tela não tem demanda, número de ofertas nem preço provável (só o aviso fixo de sigilo)", async () => {
    await show(openOverview({ clubs: [{ ...FLA3, myBid: bid }, PAL3], cash: reservedCash }));
    const sigilo = dom.$("[data-testid=sigilo]");
    expect(sigilo.textContent).toMatch(/demanda/i);
    const clone = dom.$("[data-testid=periodo]").cloneNode(true) as HTMLElement;
    clone.querySelector("[data-testid=sigilo]")!.remove();
    const rest = clone.textContent!;
    expect(rest).not.toMatch(/demanda|n[uú]mero de ofertas|ofertas de outros|prov[aá]vel|corte|rateio/i);
  });

  it("antes da abertura: só a data em que abre e nenhuma faixa", async () => {
    await show(openOverview({ status: "preparing", clubs: [], cash: null, offerSize: null, closesAt: null, tradingOpensAt: null }));
    expect(dom.text()).toContain("As ofertas abrem em 28/03/2027");
    expect(dom.$$("[data-ticker]")).toHaveLength(0);
    expect(dom.$$("button")).toHaveLength(0);
    expect(dom.text()).not.toContain("Piso");
  });

  it("ipo 8: a prévia da reserva é a bidReserve do motor, ao digitar", async () => {
    await show(openOverview());
    await openForm("FLA3", "Ofertar");
    const cases: Array<[string, string, number, number]> = [
      ["1500", "40", 1500, 4000],
      ["100", "90", 100, 9000],
      ["7", "30,33", 7, 3033],
      ["1", "70,77", 1, 7077],
    ];
    for (const [qty, price, quantity, maxPrice] of cases) {
      await dom.type("#qtd-FLA3", qty);
      await dom.type("#preco-FLA3", price);
      const expected = engineBidReserve(quantity, maxPrice, { ceiling: FLA3.band.ceiling });
      expect(dom.$("[data-testid=reserva-FLA3]").textContent).toContain(formatCents(expected));
    }
    await dom.type("#qtd-FLA3", "1500");
    await dom.type("#preco-FLA3", "40");
    expect(dom.$("[data-testid=reserva-FLA3]").textContent).toContain("R$ 60.000,00");
    expect(dom.$("[data-testid=livre-depois-FLA3]").textContent).toContain("R$ 40.000,00");
    // ipo 9: acima do teto vale como o teto
    await dom.type("#qtd-FLA3", "100");
    await dom.type("#preco-FLA3", "90");
    expect(dom.$("[data-testid=reserva-FLA3]").textContent).toContain("R$ 7.077,00");
    expect(dom.$("[data-testid=acima-do-teto-FLA3]").textContent).toContain("R$ 70,77");
  });

  it("registrar uma oferta nova manda expect new, com o preço em centavos, e atualiza oferta e caixa", async () => {
    const putBid = vi.fn(async () => ({ ticker: "FLA3", bid, cash: reservedCash }));
    const view = await show(openOverview(), fakeApi({ putBid }));
    await openForm("FLA3", "Ofertar");
    expect(dom.button("Registrar oferta", card("FLA3")).disabled).toBe(true);
    await dom.type("#qtd-FLA3", "1500");
    await dom.type("#preco-FLA3", "40");
    await dom.click(dom.button("Registrar oferta", card("FLA3")));
    expect(putBid).toHaveBeenCalledWith("FLA3", { quantity: 1500, maxPrice: 4000, expect: "new" });
    expect(view.overview().clubs[0]!.myBid).toEqual(bid);
    expect(dom.$("[data-testid=caixa-reservado]").textContent).toContain("R$ 60.000,00");
    expect(dom.$("[data-testid=caixa-livre]").textContent).toContain("R$ 40.000,00");
    expect(card("FLA3").textContent).toContain("1.500");
    expect(dom.$("#qtd-FLA3")).toBeNull();
  });

  it("ipo 13: editar manda expect existing a partir dos valores atuais; cancelar devolve a reserva ao caixa", async () => {
    const edited = { ...bid, quantity: 1000, maxPrice: 3800, reserved: 3_800_000 };
    const cash = { total: 10_000_000, reserved: 3_800_000, free: 6_200_000 };
    const putBid = vi.fn(async () => ({ ticker: "FLA3", bid: edited, cash }));
    const deleteBid = vi.fn(async () => ({ ticker: "FLA3", cash: CASH_FREE }));
    const view = await show(openOverview({ clubs: [{ ...FLA3, myBid: bid }, PAL3], cash: reservedCash }), fakeApi({ putBid, deleteBid }));
    await openForm("FLA3", "Editar");
    expect(dom.$<HTMLInputElement>("#qtd-FLA3").value).toBe("1500");
    expect(dom.$<HTMLInputElement>("#preco-FLA3").value).toBe("40,00");
    await dom.type("#qtd-FLA3", "1000");
    await dom.type("#preco-FLA3", "38");
    expect(dom.$("[data-testid=reserva-FLA3]").textContent).toContain("R$ 38.000,00");
    await dom.click(dom.button("Salvar alteração", card("FLA3")));
    expect(putBid).toHaveBeenCalledWith("FLA3", { quantity: 1000, maxPrice: 3800, expect: "existing" });
    expect(dom.$("[data-testid=caixa-reservado]").textContent).toContain("R$ 38.000,00");
    await dom.click(dom.button("Cancelar oferta", card("FLA3")));
    expect(deleteBid).toHaveBeenCalledWith("FLA3");
    expect(view.overview().clubs[0]!.myBid).toBeNull();
    expect(dom.$("[data-testid=caixa-reservado]").textContent).toContain("R$ 0,00");
    expect(dom.$("[data-testid=caixa-livre]").textContent).toContain("R$ 100.000,00");
  });

  it.each(Object.keys(IPO_ERROR_MESSAGES).filter((c) => c !== "ipo_close_earlier" && c !== "ipo_not_ready"))(
    "ipo 10, 11, 12, 14: a recusa %s mostra a mensagem do código, não o texto da resposta",
    async (code) => {
      const putBid = vi.fn(async () => {
        throw new ApiError(422, code, "TEXTO INVENTADO PELO SERVIDOR");
      });
      await show(openOverview(), fakeApi({ putBid }));
      await openForm("FLA3", "Ofertar");
      await dom.type("#qtd-FLA3", "10");
      await dom.type("#preco-FLA3", "40");
      await dom.click(dom.button("Registrar oferta", card("FLA3")));
      const alert = card("FLA3").querySelector("[role=alert]");
      expect(alert?.textContent).toBe(IPO_ERROR_MESSAGES[code as keyof typeof IPO_ERROR_MESSAGES]);
      expect(dom.text()).not.toContain("TEXTO INVENTADO");
    },
  );

  it("a recusa de cancelar também aparece pelo código", async () => {
    const deleteBid = vi.fn(async () => {
      throw new ApiError(409, "ipo_closed", "x");
    });
    await show(openOverview({ clubs: [{ ...FLA3, myBid: bid }, PAL3], cash: reservedCash }), fakeApi({ deleteBid }));
    await dom.click(dom.button("Cancelar oferta", card("FLA3")));
    expect(card("FLA3").querySelector("[role=alert]")?.textContent).toBe(IPO_ERROR_MESSAGES.ipo_closed);
  });

  it("ipo 10 e 11: os avisos antes de enviar usam as mesmas mensagens e não impedem o envio (quem decide é a API)", async () => {
    const putBid = vi.fn(async () => ({ ticker: "FLA3", bid, cash: reservedCash }));
    await show(openOverview({ cash: { total: 4_000_000, reserved: 0, free: 4_000_000 } }), fakeApi({ putBid }));
    await openForm("FLA3", "Ofertar");
    await dom.type("#qtd-FLA3", "10");
    await dom.type("#preco-FLA3", "30,32");
    expect(card("FLA3").textContent).toContain(IPO_ERROR_MESSAGES.below_band_floor);
    await dom.type("#qtd-FLA3", "1200");
    await dom.type("#preco-FLA3", "35");
    expect(card("FLA3").textContent).toContain(IPO_ERROR_MESSAGES.insufficient_cash);
    expect(dom.button("Registrar oferta", card("FLA3")).disabled).toBe(false);
    await dom.click(dom.button("Registrar oferta", card("FLA3")));
    expect(putBid).toHaveBeenCalledOnce();
  });

  it("sem carteira (no_wallet) mostra a mensagem do código e não oferece formulário", async () => {
    await show(openOverview({ cash: null }));
    expect(dom.text()).toContain(IPO_ERROR_MESSAGES.no_wallet);
    expect(dom.$$("button")).toHaveLength(0);
  });

  it("ipo 14: editar e cancelar só aparecem com o IPO aberto e antes do fechamento", async () => {
    const withBid = (status: IpoOverview["status"]) => openOverview({ status, clubs: [{ ...FLA3, myBid: bid }, PAL3], cash: reservedCash });
    await show(withBid("ipo_open"));
    expect(dom.button("Editar")).toBeDefined();
    expect(dom.button("Cancelar oferta")).toBeDefined();
    expect(dom.button("Ofertar", card("PAL3"))).toBeDefined();
  });

  it.each([
    ["ipo_closed", NOW_OPEN],
    ["ipo_open", Date.parse(CLOSES_AT) + 1000],
    ["ipo_open", Date.parse(CLOSES_AT)],
  ] as const)("ipo 14: com status %s e agora %#, nenhum botão e a mensagem de período fechado", async (status, now) => {
    await show(openOverview({ status, clubs: [{ ...FLA3, myBid: bid }, PAL3], cash: reservedCash }), fakeApi({}), now);
    expect(dom.$$("button")).toHaveLength(0);
    expect(dom.text()).toContain(IPO_ERROR_MESSAGES.ipo_closed);
    // a oferta continua visível, só para leitura
    expect(card("FLA3").textContent).toContain("1.500");
    expect(card("FLA3").textContent).toContain("R$ 60.000,00");
  });
});
