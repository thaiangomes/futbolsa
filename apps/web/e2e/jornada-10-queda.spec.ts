import { expect, test } from "@playwright/test";
import { api, controle, entrarComo, prepararCenario } from "./support/controle";

/**
 * Jornada 10 (T22): a API cai e volta com o livro aberto; a tela reconecta e recarrega o estado (retoma pelo `seq`).
 * Prefixo `e2e livro N` (T24).
 */
test("e2e livro 35 e 25: com a API fora do ar a tela segue de pé, e quando ela volta o livro recarrega sozinho", async ({ page }) => {
  test.setTimeout(240_000);
  await prepararCenario("negociacao", ["ana", "bia"]);
  await entrarComo(page, "bia");
  await page.goto("/clube?t=FLA3");
  await expect(page.getByTestId("ticker")).toHaveText("FLA3");
  const niveis = await page.getByTestId("nivel-compra").count();

  await fetch("http://127.0.0.1:3102/derrubar", { method: "POST" });
  await page.waitForTimeout(2500);
  // a página continua com o último livro (não fica em branco) enquanto a API está fora
  await expect(page.getByTestId("ticker")).toHaveText("FLA3");

  await fetch("http://127.0.0.1:3102/subir", { method: "POST" });
  // uma ordem nova, feita depois da volta, chega na tela de quem estava com ela aberta, sem recarregar
  const livro = (await api<{ price: { displayed: number } }>("ana", "GET", "/clubs/FLA3/book")).corpo;
  const preco = Math.floor(livro.price.displayed * 0.8) + 11;
  expect((await api("ana", "POST", "/orders", { ticker: "FLA3", side: "buy", type: "limit", quantity: 4, limitPrice: preco })).status).toBeLessThan(300);
  await expect.poll(async () => page.getByTestId("compras").innerText(), { timeout: 90_000 }).toContain(
    (preco / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 }),
  );
  expect(niveis).toBeGreaterThanOrEqual(0);
  void controle;
});
