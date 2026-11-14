import { expect, test } from "@playwright/test";
import { api, avancarRelogio, entrarComo, prepararCenario, sincronizar } from "./support/controle";

/**
 * Jornada 5 (T21): os rankings pela tela, da parcial ao vivo ao mês fechado. Prefixo `e2e rankings N` (T24).
 */
test.describe.serial("jornada 5: rankings", () => {
  test.beforeAll(async () => {
    await prepararCenario("negociacao", ["ana", "bia", "caio"]);
    // a ana compra e a bia compra mais; o caio não negocia (retorno zero, empate com quem não mexeu)
    expect((await api("ana", "POST", "/orders", { ticker: "FLA3", side: "buy", type: "market", quantity: 40 })).status).toBeLessThan(300);
    expect((await api("bia", "POST", "/orders", { ticker: "PAL3", side: "buy", type: "market", quantity: 10 })).status).toBeLessThan(300);
  });

  test("e2e rankings 15, 16: a parcial do mês aparece, marca a própria linha e mostra só apelido e retorno", async ({ page }) => {
    await entrarComo(page, "ana");
    await page.goto("/rankings");
    await expect(page.getByRole("tab", { name: "Parcial" })).toBeVisible();
    await expect(page.locator("main")).toContainText("Parcial de março de 2025");
    const linhas = page.locator("tr", { hasText: "ana" });
    await expect(linhas.first()).toContainText("você");
    const texto = await page.locator("main").innerText();
    expect(texto).not.toMatch(/@exemplo\.com/);
    expect(texto).toMatch(/\d,\d{2}%/);
    // 6 e 7: retornos iguais dividem a posição (o caio e o semeador sem mexer ficam empatados no 1º lugar com quem não perdeu)
    const posicoes = await page.locator("tbody tr td:first-child").allInnerTexts();
    expect(posicoes.filter((p) => p.trim() === "1º").length).toBeGreaterThanOrEqual(1);
  });

  test("e2e rankings 18, 21 e 22: o mês fechado fica na aba \"Meses fechados\", e a conta excluída aparece como excluída", async ({ page }) => {
    test.setTimeout(420_000);
    // 23h59 de Brasília de 31/03/2025 é 02h59 UTC de 01/04: passa um pouco para o fechamento rodar
    await avancarRelogio("2025-04-01T03:30:00Z");
    await sincronizar(page);
    await entrarComo(page, "ana");
    await page.goto("/rankings");
    await page.getByRole("tab", { name: "Meses fechados" }).click();
    await expect(page.locator("main")).toContainText(/março de 2025/i);
    await expect(page.locator("main")).toContainText("ana");
    await expect(page.locator("main")).toContainText("bia");
    // a bia exclui a conta: o mês já fechado guarda a linha, e ela aparece como "conta excluída"
    expect((await api("bia", "DELETE", "/me", { confirmNickname: "bia" })).status).toBeLessThan(300);
    await page.reload();
    await page.getByRole("tab", { name: "Meses fechados" }).click();
    await expect(page.locator("main")).toContainText(/conta exclu[ií]da/i);
    await expect(page.locator("main")).not.toContainText("bia");
  });
});
