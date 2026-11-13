// @vitest-environment jsdom
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { EnterResult, EntryPreview } from "@futbolsa/contracts";
import { ApiError } from "../../lib/api";
import { useDom } from "../../test-support/dom";
import type { EntryApi } from "./api";
import { changedFromPreview, EntryScreen } from "./entry-screen";

const clubs = [
  { ticker: "FLA3", price: 4400, shares: 134 },
  { ticker: "PAL3", price: 4000, shares: 134 },
];
const openPreview = (): EntryPreview => ({
  availability: "open",
  defaultMode: "index",
  quote: { n: 134, sum: 8400, cash: 3_032_000, stockValue: 6_968_000, clubCount: 2, clubs },
});
const result = (over: Partial<EnterResult> = {}): EnterResult => ({
  mode: "index",
  n: 134,
  sum: 8400,
  cash: 3_032_000,
  stockValue: 6_968_000,
  enteredAt: "2027-06-15T13:00:00.000Z",
  repeated: false,
  clubs,
  ...over,
});
const fakeApi = (o: Partial<EntryApi>): EntryApi =>
  ({ preview: vi.fn(async () => openPreview()), enter: vi.fn(async () => result()), ...o }) as EntryApi;

describe("tela de entrada no meio da temporada", () => {
  const dom = useDom();

  it("entrada 9: a carteira índice vem marcada, com as cotações e a quantidade da prévia", async () => {
    await dom.render(createElement(EntryScreen, { api: fakeApi({}), refreshMs: 0 }));
    expect(dom.$<HTMLInputElement>('input[value="index"]').checked).toBe(true);
    expect(dom.$$("[data-ticker]")).toHaveLength(2);
    expect(dom.text()).toContain("134 ações de cada");
    expect(dom.text()).toContain("R$ 30.320,00");
  });

  it("só caixa: esconde as cotações e confirma o modo escolhido", async () => {
    const enter = vi.fn(async () => result({ mode: "cash", n: 0, sum: 0, cash: 10_000_000, stockValue: 0, clubs: [] }));
    await dom.render(createElement(EntryScreen, { api: fakeApi({ enter }), refreshMs: 0 }));
    await dom.click(dom.$('input[value="cash"]'));
    expect(dom.$$("[data-ticker]")).toHaveLength(0);
    await dom.click(dom.button("Confirmar"));
    expect(enter).toHaveBeenCalledWith("cash");
    expect(dom.text()).toContain("Pronto, você entrou");
    expect(dom.text()).toContain("R$ 100.000,00");
  });

  it("entrada 8: se o preço mudou entre a prévia e a confirmação, a tela avisa e mostra o resultado final", async () => {
    const enter = vi.fn(async () => result({ n: 133, cash: 3_100_000 }));
    await dom.render(createElement(EntryScreen, { api: fakeApi({ enter }), refreshMs: 0 }));
    await dom.click(dom.button("Confirmar"));
    expect(dom.text()).toContain("Os preços mudaram");
    expect(dom.text()).toContain("133 de cada");
  });

  it("changedFromPreview não avisa quando nada mudou nem no só caixa", () => {
    const quote = openPreview().quote!;
    expect(changedFromPreview(quote, result())).toBeNull();
    expect(changedFromPreview(quote, result({ mode: "cash", n: 0 }))).toBeNull();
  });

  it("entrada 12: janela fechada mostra R$ 0,00 e o aviso do IPO do ano seguinte, sem escolha", async () => {
    const preview = vi.fn(
      async (): Promise<EntryPreview> => ({
        availability: "window_closed",
        message: "A entrada no meio da temporada acabou: sua conta entra no IPO do ano seguinte.",
      }),
    );
    await dom.render(createElement(EntryScreen, { api: fakeApi({ preview }), refreshMs: 0 }));
    expect(dom.text()).toContain("R$ 0,00");
    expect(dom.text()).toContain("IPO do ano seguinte");
    expect(dom.$$('input[type="radio"]')).toHaveLength(0);
  });

  it("liquidando: mensagem e botão para tentar de novo", async () => {
    let state: EntryPreview = { availability: "settling", message: "Estamos fechando o IPO, tente de novo em instantes." };
    const preview = vi.fn(async () => state);
    await dom.render(createElement(EntryScreen, { api: fakeApi({ preview }), refreshMs: 0 }));
    expect(dom.text()).toContain("fechando o IPO");
    state = openPreview();
    await dom.click(dom.button("Tentar de novo"));
    expect(dom.$$("[data-ticker]")).toHaveLength(2);
  });

  it("503 entry_busy: mostra o erro e deixa tentar de novo", async () => {
    const enter = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(503, "entry_busy", "Muita gente entrando agora, tente de novo em instantes."))
      .mockResolvedValueOnce(result());
    await dom.render(createElement(EntryScreen, { api: fakeApi({ enter }), refreshMs: 0 }));
    await dom.click(dom.button("Confirmar"));
    expect(dom.text()).toContain("Muita gente entrando");
    await dom.click(dom.button("Confirmar"));
    expect(dom.text()).toContain("Pronto, você entrou");
  });

  it("já entrou: leva para a carteira", async () => {
    const preview = vi.fn(
      async (): Promise<EntryPreview> => ({ availability: "already_entered", message: "Você já tem carteira nesta temporada.", mode: "index" }),
    );
    await dom.render(createElement(EntryScreen, { api: fakeApi({ preview }), refreshMs: 0 }));
    expect(dom.$<HTMLAnchorElement>('a[href="/carteira"]')).toBeTruthy();
  });
});
