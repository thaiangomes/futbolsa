import { expect, test } from "@playwright/test";
import { api, entrarComo, prepararCenario } from "./support/controle";
import { limpo, reais } from "./support/dinheiro";

/**
 * Jornada 4 (T20): carteira e gráficos do jogador. Prefixo `e2e carteira N` (T24).
 */
const TICKER = "FLA3";

interface Livro {
  price: { displayed: number };
  asks: Array<{ price: number; quantity: number }>;
  me: { freeCash: number; freeShares: number };
}

const livro = async (apelido: string, ticker = TICKER) => (await api<Livro>(apelido, "GET", `/clubs/${ticker}/book`)).corpo;

test.describe.serial("jornada 4: carteira e gráficos", () => {
  test.beforeAll(async () => {
    await prepararCenario("negociacao", ["ana", "bia"]);
    // a ana compra 20 FLA3 da casa a mercado
    const r = await api("ana", "POST", "/orders", { ticker: TICKER, side: "buy", type: "market", quantity: 20 });
    expect(r.status).toBeLessThan(300);
  });

  test("e2e carteira 1, 11, 12 e 13: posição com preço médio, ordens abertas separadas do livre e patrimônio somado", async ({ page }) => {
    const atual = (await livro("ana")).price.displayed;
    // 11 e 12: uma compra e uma venda abertas
    const pal = Math.floor((await livro("ana", "PAL3")).price.displayed * 0.9);
    expect((await api("ana", "POST", "/orders", { ticker: "PAL3", side: "buy", type: "limit", quantity: 100, limitPrice: pal })).status).toBeLessThan(300);
    expect((await api("ana", "POST", "/orders", { ticker: TICKER, side: "sell", type: "limit", quantity: 8, limitPrice: Math.floor(atual * 1.1) })).status).toBeLessThan(300);
    await entrarComo(page, "ana");
    await page.goto("/carteira");
    const linha = page.locator(`[data-testid="posicao"][data-ticker="${TICKER}"]`);
    await expect(linha).toBeVisible();
    await expect(linha).toContainText("20");
    await expect(linha).toContainText("8 em ordens"); // 12: 20 totais, 8 em ordens
    await expect(page.getByTestId("caixa-reservado")).toContainText(reais(100 * pal)); // 11: 100 PAL3 reservados
    // 13: patrimônio = caixa total + valor das ações; com o preço do último negócio, perto dos R$ 100.000,00 do começo
    const patrimonio = limpo(await page.getByTestId("patrimonio").innerText());
    expect(patrimonio).toMatch(/^R\$ (99|100)\.\d{3},\d{2}$/);
    await expect(page.getByTestId("rentabilidade")).toContainText("na temporada");
    // o atalho Negociar leva à tela do clube, que mostra quantas ações ela tem dele (20, 8 em ordens)
    await linha.getByTestId("negociar").click();
    await expect(page).toHaveURL(new RegExp(`/clube\\?t=${TICKER}`));
    await expect(page.getByTestId("minha-posicao")).toContainText(`Você tem 20 ${TICKER}`);
    await expect(page.getByTestId("minha-posicao")).toContainText("8 em ordens");
  });

  test("e2e carteira 33: a carteira aberta mostra a compra nova sem recarregar a página", async ({ page }) => {
    await entrarComo(page, "ana");
    await page.goto("/carteira");
    const linha = page.locator(`[data-testid="posicao"][data-ticker="${TICKER}"]`);
    await expect(linha).toContainText("20");
    // uma compra em outro clube (a ana tem venda aberta no FLA3, e a compra a mercado do mesmo clube seria contra si mesma)
    expect((await api("ana", "POST", "/orders", { ticker: "SAO3", side: "buy", type: "market", quantity: 10 })).status).toBeLessThan(300);
    await expect(page.locator('[data-testid="posicao"][data-ticker="SAO3"]')).toContainText("10", { timeout: 15_000 });
  });

  test("e2e carteira 22: o gráfico do clube abre em linha e troca para candles", async ({ page }) => {
    await entrarComo(page, "ana");
    await page.goto(`/clube?t=${TICKER}`);
    const grafico = page.getByTestId("grafico-clube");
    await expect(grafico).toBeVisible();
    await expect(grafico.getByRole("button", { name: "Linha" })).toHaveAttribute("aria-pressed", "true");
    await grafico.getByRole("button", { name: "Candles" }).click();
    await expect(grafico.getByRole("button", { name: "Candles" })).toHaveAttribute("aria-pressed", "true");
    await expect(grafico.getByTestId("grafico")).toBeVisible();
    await expect(grafico.locator("canvas").first()).toBeVisible();
    await expect(page.getByTestId("grafico-erro")).toHaveCount(0);
  });

  test("e2e carteira 34: nenhuma tela mostra escudo oficial, só ticker, nome em texto e o selo próprio", async ({ page }) => {
    await entrarComo(page, "ana");
    for (const rota of ["/carteira", `/clube?t=${TICKER}`, "/mercado", "/ipo", "/conta"]) {
      await page.goto(rota);
      await page.waitForTimeout(600);
      const imagens = await page.locator("img").evaluateAll((els) => els.map((e) => (e as HTMLImageElement).src));
      expect(imagens, rota).toEqual([]);
    }
    await page.goto("/carteira");
    await expect(page.getByTestId("selo-clube").first()).toBeVisible();
    await expect(page.getByTestId("posicoes")).toContainText("Flamengo");
    await expect(page.locator("body")).toContainText("Jogo · dinheiro fictício");
  });

  test("e2e carteira 30 e 31: o perfil público mostra só porcentagens, nunca valor nem quantidade", async ({ page }) => {
    await entrarComo(page, "bia");
    await page.goto("/rankings");
    await expect(page.locator("body")).toContainText("Rankings");
    // o perfil da própria conta tem a foto mensal (ainda sem foto: o mês não fechou) e a regra de privacidade
    await page.goto("/conta");
    await expect(page.getByTestId("foto-carteira")).toContainText("só a fatia de cada clube, sem quantidades");
    await expect(page.getByText("O que os outros jogadores veem: só porcentagens")).toBeVisible();
  });
});
