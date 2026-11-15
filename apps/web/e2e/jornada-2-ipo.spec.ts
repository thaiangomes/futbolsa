import { expect, test, type Page } from "@playwright/test";
import { api, avancarRelogio, criarJogador, entrarComo, prepararCenario, sincronizar } from "./support/controle";
import { campo, reais } from "./support/dinheiro";

/**
 * Jornada 2 (T20): o IPO pela tela, da oferta ao resultado. Prefixo `e2e ipo N` (T24).
 */
interface Faixa {
  floor: number;
  ceiling: number;
}

async function faixaDe(ticker: string): Promise<Faixa> {
  const r = await api<{ clubs: Array<{ ticker: string; band: Faixa }> }>("ana", "GET", "/ipo");
  return r.corpo.clubs.find((c) => c.ticker === ticker)!.band;
}

const cartao = (page: Page, ticker: string) => page.locator(`li[data-ticker="${ticker}"]`);

async function abrirOferta(page: Page, ticker: string) {
  await cartao(page, ticker).getByRole("button", { name: /Ofertar|Editar/ }).click();
  return cartao(page, ticker).locator("form");
}

test.describe.serial("jornada 2: IPO", () => {
  let faixa: Faixa;

  test.beforeAll(async () => {
    await prepararCenario("ipo-aberto");
    await criarJogador("ana");
    faixa = await faixaDe("FLA3");
  });

  test("e2e ipo 15: com o período aberto a tela mostra a faixa, a oferta e o sigilo da demanda", async ({ page }) => {
    await entrarComo(page, "ana");
    await page.goto("/ipo");
    await expect(page.getByTestId("sigilo")).toContainText("A demanda fica escondida");
    await expect(cartao(page, "FLA3")).toContainText("Piso");
    await expect(cartao(page, "FLA3")).toContainText(reais(faixa.ceiling));
    await expect(page.getByTestId("caixa-livre")).toContainText("R$ 100.000,00");
    expect(await page.locator("body").innerText()).not.toMatch(/DEMANDA NO PREÇO/i);
  });

  test("e2e ipo 8, 9, 10 e 11: a reserva, o teto, o piso e o caixa insuficiente aparecem na boleta da oferta", async ({ page }) => {
    await entrarComo(page, "ana");
    await page.goto("/ipo");
    const form = await abrirOferta(page, "FLA3");
    const qtd = form.getByLabel("Quantidade de ações");
    const preco = form.getByLabel("Preço máximo (R$)");
    const registrar = form.getByRole("button", { name: "Registrar oferta" });
    // 8: a reserva é quantidade × preço
    await qtd.fill("100");
    await preco.fill(campo(faixa.ceiling));
    await expect(page.getByTestId("reserva-FLA3")).toHaveText(reais(100 * faixa.ceiling));
    // 9: acima do teto vale o teto
    await preco.fill(campo(faixa.ceiling * 2));
    await expect(page.getByTestId("reserva-FLA3")).toHaveText(reais(100 * faixa.ceiling));
    await expect(page.getByTestId("acima-do-teto-FLA3")).toBeVisible();
    // 10: abaixo do piso a boleta avisa, e a API recusa se a pessoa mandar assim mesmo (nada fica reservado)
    await preco.fill(campo(faixa.floor - 1));
    await expect(form).toContainText("abaixo do piso da faixa");
    await registrar.click();
    await expect(cartao(page, "FLA3")).toContainText("Sem oferta neste clube");
    await expect(page.getByTestId("caixa-reservado")).toContainText("R$ 0,00");
    // 11: mais do que o caixa cobre: aviso na boleta e recusa da API, sem reserva
    await qtd.fill("100000");
    await preco.fill(campo(faixa.ceiling));
    await expect(form).toContainText("caixa livre não cobre");
    await registrar.click();
    await expect(cartao(page, "FLA3")).toContainText("Sem oferta neste clube");
    await expect(page.getByTestId("caixa-livre")).toContainText("R$ 100.000,00");
  });

  test("e2e ipo 12 e 13: registrar, editar a mesma oferta (reserva nova) e cancelar (reserva zera)", async ({ page }) => {
    await entrarComo(page, "ana");
    await page.goto("/ipo");
    let form = await abrirOferta(page, "FLA3");
    await form.getByLabel("Quantidade de ações").fill("150");
    await form.getByLabel("Preço máximo (R$)").fill(campo(faixa.ceiling));
    await form.getByRole("button", { name: "Registrar oferta" }).click();
    await expect(cartao(page, "FLA3")).toContainText("Sua quantidade");
    await expect(page.getByTestId("caixa-reservado")).toContainText(reais(150 * faixa.ceiling));
    // a barra de saldo presa na base acompanha a oferta sem precisar subir a página
    await expect(page.getByTestId("saldo-barra-reservado")).toContainText(reais(150 * faixa.ceiling));
    await expect(page.getByTestId("saldo-barra-ofertas")).toHaveText("1");
    // 12: a oferta é uma só por clube: o botão agora é "Editar"
    await expect(cartao(page, "FLA3").getByRole("button", { name: "Ofertar" })).toHaveCount(0);
    form = await abrirOferta(page, "FLA3");
    await form.getByLabel("Quantidade de ações").fill("100");
    await form.getByRole("button", { name: "Salvar alteração" }).click();
    await expect(page.getByTestId("caixa-reservado")).toContainText(reais(100 * faixa.ceiling));
    // 13: cancelar devolve a reserva
    await cartao(page, "FLA3").getByRole("button", { name: "Cancelar oferta" }).click();
    await expect(page.getByTestId("caixa-reservado")).toContainText("R$ 0,00");
    await expect(page.getByTestId("saldo-barra-ofertas")).toHaveText("0");
    await expect(cartao(page, "FLA3")).toContainText("Sem oferta neste clube");
  });

  test("e2e ipo 14 e 24: depois do fechamento só leitura; na abertura do mercado o resultado traz corte, demanda e rateio", async ({ page }) => {
    // uma oferta que vira resultado
    const r = await api("ana", "PUT", "/ipo/bids/FLA3", { quantity: 200, maxPrice: faixa.ceiling, expect: "new" });
    expect(r.status).toBe(200);
    await avancarRelogio("fechamento-ipo", 60_000);
    await sincronizar(page);
    await entrarComo(page, "ana");
    await page.goto("/ipo");
    // 14: nada de ofertar, registrar, editar ou cancelar: a tela é só o resultado, e a API também recusa
    await expect(page.getByRole("heading", { name: "Resultado do IPO" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Ofertar|Editar|Cancelar|Registrar/ })).toHaveCount(0);
    const recusa = await api("ana", "PUT", "/ipo/bids/FLA3", { quantity: 1, maxPrice: faixa.ceiling, expect: "existing" });
    expect(recusa.status).toBeGreaterThanOrEqual(400);
    // 24: o resultado por clube, com corte, demanda, rateio e o que a casa recebeu; e o que a pessoa recebeu
    await avancarRelogio("abertura-negociacao", 3_600_000);
    await sincronizar(page);
    await page.goto("/ipo");
    const bloco = page.getByRole("list", { name: "Resultado por clube" }).locator("li", { hasText: "FLA3" });
    await expect(bloco).toContainText("Preço de corte");
    await expect(bloco).toContainText("Demanda no preço");
    await expect(bloco).toContainText("Fração do rateio");
    await expect(bloco).toContainText("Tesouraria");
    await expect(page.getByTestId("resumo-acoes")).toContainText("200");
  });
});
