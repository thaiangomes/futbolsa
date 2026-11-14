import { expect, test, type Page } from "@playwright/test";
import { convidado, entrarComToken, prepararCenario } from "./support/controle";
import { limpo, reais } from "./support/dinheiro";

/**
 * Jornada 6 (T21): quem chega com a temporada em andamento escolhe como entrar. Prefixo `e2e entrada N` (T24).
 */
async function criarConta(page: Page, email: string, apelido: string) {
  const { token } = await convidado(email);
  await entrarComToken(page, token);
  await page.goto("/cadastro");
  await page.getByLabel("Apelido").fill(apelido);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Criar conta" }).click();
  await expect(page.getByText("Sua conta foi criada")).toBeVisible();
}

test.describe.serial("jornada 6: entrada no meio da temporada", () => {
  test.beforeAll(async () => {
    await prepararCenario("negociacao", ["ana"]);
  });

  test("e2e entrada 9: quem cria a conta depois do IPO vê R$ 0,00 e a tela de escolha com a carteira índice marcada", async ({ page }) => {
    await criarConta(page, "carla@exemplo.com", "carla");
    await page.goto("/carteira");
    await expect(page.locator("body")).toContainText(/ainda não entrou na temporada|R\$ 0,00/);
    await page.goto("/entrada");
    await expect(page.getByRole("radio").first()).toBeChecked();
    await expect(page.locator("body")).toContainText("Carteira índice (recomendada)");
    await expect(page.locator("body")).toContainText("Só caixa");
  });

  test("e2e entrada 1: a carteira índice entrega ações de cada clube e o resto em caixa, e a escolha não se desfaz (10)", async ({ page }) => {
    const { token } = await convidado("carla@exemplo.com");
    await entrarComToken(page, token);
    await page.goto("/entrada");
    await page.getByRole("button", { name: "Confirmar" }).click();
    await expect(page.locator("body")).toContainText(/entrou|confirmad|Carteira índice/i);
    await page.goto("/carteira");
    await expect(page.getByTestId("posicao")).toHaveCount(20);
    const caixa = limpo(await page.getByTestId("caixa-total").innerText());
    expect(caixa).toMatch(/^R\$ [\d.]+,\d{2}$/);
    // 1: patrimônio no começo é R$ 100.000,00 (ações pelo preço de agora + caixa)
    await expect(page.getByTestId("patrimonio")).toContainText("R$ 100.0");
    // 10: trocar para só caixa é recusado pela API e a carteira continua igual
    const recusa = await fetch("http://127.0.0.1:3100/entry", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ mode: "cash" }),
    });
    expect(recusa.status).toBeGreaterThanOrEqual(400);
    expect(await recusa.text()).toContain("already_entered");
    await page.goto("/carteira");
    await expect(page.getByTestId("posicao")).toHaveCount(20);
  });

  test("e2e entrada 2: quem escolhe só caixa recebe R$ 100.000,00 e nenhuma ação", async ({ page }) => {
    await criarConta(page, "davi@exemplo.com", "davi");
    await page.goto("/entrada");
    await page.getByRole("radio").nth(1).check();
    await page.getByRole("button", { name: "Confirmar" }).click();
    await page.goto("/carteira");
    await expect(page.getByTestId("caixa-total")).toContainText(reais(10_000_000));
    await expect(page.getByTestId("posicao")).toHaveCount(0);
    await expect(page.getByTestId("sem-posicoes")).toBeVisible();
  });
});
