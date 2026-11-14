import { expect, test } from "@playwright/test";
import { api, entrarComo, prepararCenario } from "./support/controle";

/**
 * Jornada 9 (T22): as telas principais com 390 px de largura (celular): sem rolagem horizontal e com as ações à mão.
 * Prefixo `e2e livro N` e `e2e carteira N` (T24).
 */
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const semRolagemHorizontal = async (page: import("@playwright/test").Page, rota: string) => {
  const { largura, janela } = await page.evaluate(() => ({ largura: document.documentElement.scrollWidth, janela: window.innerWidth }));
  expect(largura, `${rota}: rolagem horizontal (${largura} > ${janela})`).toBeLessThanOrEqual(janela);
};

test.describe.serial("jornada 9: celular", () => {
  test.beforeAll(async () => {
    await prepararCenario("negociacao", ["ana"]);
    expect((await api("ana", "POST", "/orders", { ticker: "FLA3", side: "buy", type: "market", quantity: 20 })).status).toBeLessThan(300);
  });

  test("e2e livro 35 e carteira 33: nenhuma tela principal rola para os lados com 390 px", async ({ page }) => {
    await entrarComo(page, "ana");
    for (const rota of ["/mercado", "/clube?t=FLA3", "/carteira", "/ipo", "/rankings", "/conta"]) {
      await page.goto(rota);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(500);
      await semRolagemHorizontal(page, rota);
    }
  });

  test("e2e livro 1: no celular a boleta abre numa folha pelos botões Comprar e Vender, e a ordem sai", async ({ page }) => {
    await entrarComo(page, "ana");
    await page.goto("/clube?t=FLA3");
    await expect(page.getByTestId("clube-celular")).toBeVisible();
    await expect(page.getByRole("button", { name: "Comprar" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Vender" })).toBeVisible();
    await page.getByRole("button", { name: "Comprar" }).click();
    const folha = page.getByTestId("folha-boleta");
    await expect(folha).toBeVisible();
    await folha.getByRole("button", { name: "A mercado" }).click();
    await folha.getByLabel("Quantidade", { exact: true }).fill("2");
    await folha.getByRole("button", { name: "Revisar compra" }).click();
    await folha.getByRole("button", { name: "Confirmar e enviar" }).click();
    await expect(folha.getByTestId("enviada")).toBeVisible();
    await semRolagemHorizontal(page, "/clube com a folha aberta");
  });

  test("e2e carteira 1: a carteira mostra o patrimônio e as posições no celular, dentro da tela", async ({ page }) => {
    await entrarComo(page, "ana");
    await page.goto("/carteira");
    await expect(page.getByTestId("patrimonio")).toBeVisible();
    await expect(page.locator("main")).toContainText("FLA3");
    await semRolagemHorizontal(page, "/carteira");
  });
});
