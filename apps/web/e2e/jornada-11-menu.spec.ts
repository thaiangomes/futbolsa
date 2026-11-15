import { expect, test } from "@playwright/test";
import { entrarComo, prepararCenario } from "./support/controle";

/**
 * Jornada 11: o menu do jogador. No computador, a barra do topo; no celular, as abas na base. O item da página atual fica
 * destacado e o menu não aparece nas telas de entrada. Prefixo `e2e menu N`.
 */
test.describe.serial("jornada 11: menu do jogador", () => {
  test.beforeAll(async () => {
    await prepararCenario("negociacao", ["ana"]);
  });

  test("e2e conta 28, menu 1: no computador, o topo leva de uma tela à outra sem digitar endereço e destaca a atual", async ({ page }) => {
    await entrarComo(page, "ana");
    await page.goto("/mercado");
    const menu = page.getByRole("navigation", { name: "Principal" });
    await expect(menu.getByRole("link", { name: "Mercado" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("menu-abas")).toBeHidden();

    for (const [item, rota, titulo] of [
      ["IPO", "/ipo", "IPO dos clubes"],
      ["Carteira", "/carteira", "Carteira"],
      ["Rankings", "/rankings", "Rankings"],
      ["Mercado", "/mercado", "Mercado"],
    ] as const) {
      await menu.getByRole("link", { name: item }).click();
      await expect(page).toHaveURL(new RegExp(`${rota}/?$`));
      await expect(page.getByRole("heading", { level: 1, name: titulo })).toBeVisible();
      await expect(menu.getByRole("link", { name: item })).toHaveAttribute("aria-current", "page");
    }

    // a Conta fica à direita, no avatar
    await page.getByRole("link", { name: /Minha conta, ana/ }).click();
    await expect(page).toHaveURL(/\/conta\/?$/);
  });

  test("e2e menu 2: a tela de um clube mantém Mercado destacado", async ({ page }) => {
    await entrarComo(page, "ana");
    await page.goto("/clube?t=FLA3");
    await expect(page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Mercado" })).toHaveAttribute("aria-current", "page");
  });

  test("e2e menu 3: o menu não aparece nas telas de entrada", async ({ page }) => {
    await page.goto("/entrar");
    await expect(page.getByTestId("menu-topo")).toHaveCount(0);
    await expect(page.getByTestId("menu-abas")).toHaveCount(0);
  });

  test.describe("no celular", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test("e2e menu 4: as abas ficam na base, levam às telas e a aba atual fica destacada", async ({ page }) => {
      await entrarComo(page, "ana");
      await page.goto("/mercado");
      const abas = page.getByTestId("menu-abas");
      await expect(abas).toBeVisible();
      await expect(page.getByTestId("menu-topo").getByRole("navigation", { name: "Principal" })).toBeHidden();
      // presas na base da janela
      const caixa = await abas.boundingBox();
      expect(caixa!.y + caixa!.height).toBeGreaterThanOrEqual(844 - 1);

      for (const [aba, rota] of [["IPO", "/ipo"], ["Carteira", "/carteira"], ["Rankings", "/rankings"], ["Perfil", "/conta"]] as const) {
        await abas.getByRole("link", { name: aba }).click();
        await expect(page).toHaveURL(new RegExp(`${rota}/?$`));
        await expect(abas.getByRole("link", { name: aba })).toHaveAttribute("aria-current", "page");
      }
    });
  });
});
