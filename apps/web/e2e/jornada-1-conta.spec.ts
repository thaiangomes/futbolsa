import { expect, test } from "@playwright/test";
import { convidado, criarJogador, definirContas, entrarComo, entrarComToken, prepararCenario, tokenDe } from "./support/controle";

/**
 * Jornada 1 (T20): conta e cadastro, do convite ao primeiro apelido. Os testes levam o prefixo `e2e conta N` (T24).
 */
test.describe.serial("jornada 1: conta e cadastro", () => {
  test.beforeAll(async () => {
    await prepararCenario("ipo-aberto");
    await criarJogador("anagol");
  });

  test("e2e conta 8, 9, 25 e 2: o apelido repetido, malformado ou reservado é recusado; sem o aceite a conta não nasce", async ({ page }) => {
    const { token } = await convidado("bia@exemplo.com");
    await entrarComToken(page, token);
    await page.goto("/cadastro");
    const apelido = page.getByLabel("Apelido");
    const criar = page.getByRole("button", { name: "Criar conta" });
    await page.getByRole("checkbox").check();
    // 9: curto, longo e com acento não deixam criar; 25: nomes reservados também não
    for (const ruim of ["ab", "um_apelido_com_mais_de_20", "joão", "Casa", "ADMIN", "conta_excluida"]) {
      await apelido.fill(ruim);
      await expect(criar, `apelido ${ruim}`).toBeDisabled();
    }
    // 8: a mesma grafia, com outra caixa, de um apelido em uso é recusada pela API, e a tela mostra o motivo
    await apelido.fill("AnaGol");
    await criar.click();
    await expect(page.locator("body")).toContainText(/em uso|já existe|já está/i);
    // 2: sem o aceite dos termos, nada de conta (mesmo com apelido bom)
    await apelido.fill("joao_10");
    await expect(criar).toBeEnabled();
    await page.getByRole("checkbox").uncheck();
    await expect(criar).toBeDisabled();
  });

  test("e2e conta 9 e 21: com apelido bom e aceite a conta nasce, sem pedir idade nem nascimento", async ({ page }) => {
    const { token } = await convidado("carla@exemplo.com");
    await entrarComToken(page, token);
    await page.goto("/cadastro");
    expect(await page.locator("body").innerText()).not.toMatch(/nascimento|idade:/i);
    await page.getByLabel("Apelido").fill("joao_10");
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Criar conta" }).click();
    await expect(page.getByText("joao_10").first()).toBeVisible();
    await page.goto("/carteira");
    // 13: com as ofertas abertas, quem cria a conta já tem R$ 100.000,00
    await expect(page.locator("body")).toContainText("R$ 100.000,00");
  });

  test("e2e conta 1: e-mail sem convite cai na tela de convite, sem conta", async ({ page }) => {
    const { token } = await convidado("intruso@exemplo.com", true);
    await entrarComToken(page, token);
    await page.goto("/cadastro");
    await expect(page).toHaveURL(/sem-convite/);
    await expect(page.locator("body")).toContainText("Falta o convite");
  });

  test("e2e conta 6: senha errada e e-mail sem conta dão a mesma mensagem", async ({ page }) => {
    const { token } = await tokenDe("anagol");
    await definirContas(page, { "anagol@exemplo.com": { password: "senha-certa-1", token } });
    await page.goto("/entrar");
    const tentar = async (email: string, senha: string) => {
      await page.getByLabel("E-mail").fill(email);
      await page.getByLabel("Senha").fill(senha);
      await page.getByRole("button", { name: "Entrar", exact: true }).click();
      const aviso = page.getByRole("alert").first();
      await expect(aviso).toBeVisible();
      return (await aviso.innerText()).trim();
    };
    const errada = await tentar("anagol@exemplo.com", "senha-errada-1");
    const semConta = await tentar("ninguem@exemplo.com", "senha-errada-1");
    expect(errada).toBe(semConta);
    expect(errada).toMatch(/E-mail ou senha incorretos/);
  });

  test("e2e conta 11: nenhuma tela de rankings, mercado ou conta mostra o e-mail de outra pessoa", async ({ page }) => {
    await entrarComo(page, "anagol");
    for (const rota of ["/rankings", "/mercado", "/conta"]) {
      await page.goto(rota);
      await page.waitForTimeout(800);
      const texto = await page.locator("body").innerText();
      expect(texto, rota).not.toContain("carla@exemplo.com");
    }
  });
});
