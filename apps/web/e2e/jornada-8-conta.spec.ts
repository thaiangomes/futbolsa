import { expect, test } from "@playwright/test";
import { api, convidado, entrarComo, entrarComToken, prepararCenario, tokenDe } from "./support/controle";

/**
 * Jornada 8 (T21): conta e perfil, da troca de apelido à exclusão. Prefixo `e2e conta N` (T24).
 */
test.describe.serial("jornada 8: conta e perfil", () => {
  test.beforeAll(async () => {
    await prepararCenario("negociacao", ["ana", "bia"]);
    // a bia compra ações e deixa uma ordem aberta: a exclusão tem o que cancelar e devolver
    expect((await api("bia", "POST", "/orders", { ticker: "FLA3", side: "buy", type: "market", quantity: 30 })).status).toBeLessThan(300);
    expect((await api("bia", "POST", "/orders", { ticker: "FLA3", side: "sell", type: "limit", quantity: 10, limitPrice: 2600 })).status).toBeLessThan(300);
  });

  test("e2e conta 10, 8 e 25: trocar o apelido recusa o reservado e o repetido, e o ranking mostra o novo e libera o antigo", async ({ page }) => {
    await entrarComo(page, "ana");
    await page.goto("/conta");
    const campo = page.getByLabel("Apelido", { exact: true });
    const trocar = page.getByRole("button", { name: "Trocar", exact: true });
    // 25: nomes reservados não passam
    for (const reservado of ["Casa", "ADMIN", "conta_excluida"]) {
      await campo.fill(reservado);
      await expect(trocar, reservado).toBeDisabled();
    }
    // 8: um apelido que já existe (com outra caixa) é recusado
    await campo.fill("BIA");
    await trocar.click();
    await expect(page.locator("body")).toContainText(/em uso|já existe|já está/i);
    // 10: um apelido livre é aceito
    await campo.fill("ana_fla");
    await expect(trocar).toBeEnabled();
    await trocar.click();
    await expect(page.getByText("ana_fla").first()).toBeVisible();
    await page.goto("/rankings");
    await expect(page.locator("body")).toContainText("ana_fla");
    await expect(page.locator("body")).not.toContainText(/\bana\b(?!_)/);
    // o apelido antigo ficou livre: outra pessoa convidada o escolhe
    const { token } = await convidado("eva@exemplo.com");
    await entrarComToken(page, token);
    await page.goto("/cadastro");
    await page.getByLabel("Apelido").fill("ana");
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Criar conta" }).click();
    await expect(page.getByText("Sua conta foi criada")).toBeVisible();
  });

  test("e2e conta 22 e 23: excluir a conta cancela as ordens, tira o jogador dos rankings e o e-mail volta a precisar de convite", async ({ page }) => {
    const { token } = await tokenDe("bia");
    await entrarComToken(page, token);
    await page.goto("/conta");
    await expect(page.getByText("bia@exemplo.com")).toBeVisible();
    await page.getByLabel("Para confirmar, digite seu apelido").fill("bia");
    await page.getByRole("button", { name: "Excluir minha conta" }).click();
    // a conta some: a API não a conhece mais e as ordens dela saem do livro
    await expect(page.getByRole("heading", { name: "Entrar no jogo" })).toBeVisible();
    const me = await (await fetch("http://127.0.0.1:3100/me", { headers: { authorization: `Bearer ${token}` } })).text();
    expect(me).not.toContain("bia");
    const livro = await api<{ asks: Array<{ price: number; orders: number }> }>("ana", "GET", "/clubs/FLA3/book");
    expect(livro.corpo.asks.find((n) => n.price === 2600)).toBeUndefined();
    // 23: o mesmo e-mail, sem convite, cai na tela de convite
    const sem = await convidado("bia@exemplo.com", true);
    await entrarComToken(page, sem.token);
    await page.goto("/cadastro");
    await expect(page).toHaveURL(/sem-convite/);
    // e o e-mail dela nunca aparece nos rankings
    await page.goto("/rankings");
    await expect(page.locator("body")).not.toContainText("bia@exemplo.com");
  });
});
