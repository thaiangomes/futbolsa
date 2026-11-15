import { expect, test, type Page } from "@playwright/test";
import { api, avancarRelogio, entrarComo, prepararCenario, sincronizar } from "./support/controle";
import { campo, limpo, reais } from "./support/dinheiro";

/**
 * Jornada 3 (T20): o mercado pela tela, da compra da casa ao livro que muda sem recarregar. Prefixo `e2e livro N` (T24).
 * O mundo começa com a negociação aberta num domingo (a abertura do IPO de 2025 cai num domingo às 10h de Brasília).
 */
const TICKER = "FLA3";

interface Livro {
  price: { displayed: number };
  me: { band: { min: number; max: number }; freeCash: number; freeShares: number } | null;
  asks: Array<{ price: number; quantity: number }>;
  bids: Array<{ price: number; quantity: number }>;
}

const livro = async (apelido: string, ticker = TICKER) => (await api<Livro>(apelido, "GET", `/clubs/${ticker}/book`)).corpo;

async function preencher(page: Page, quantidade: string, preco?: string) {
  await page.getByLabel("Quantidade", { exact: true }).fill(quantidade);
  if (preco !== undefined) await page.getByLabel("Preço", { exact: true }).fill(preco);
}

async function enviar(page: Page, revisar: "Revisar compra" | "Revisar venda") {
  await page.getByRole("button", { name: revisar }).click();
  await page.getByRole("button", { name: "Confirmar e enviar" }).click();
}

test.describe.serial("jornada 3: mercado", () => {
  let preco: number;

  test.beforeAll(async () => {
    await prepararCenario("negociacao", ["ana", "bia"]);
    preco = (await livro("ana")).price.displayed;
  });

  test("e2e livro 22, 20 e 18: negociação aberta no domingo, preço e variação do dia e livro de 5 níveis sem apelidos", async ({ page }) => {
    await entrarComo(page, "ana");
    await page.goto("/mercado");
    await expect(page.getByTestId("clube")).toHaveCount(20);
    await page.locator(`[data-ticker="${TICKER}"] [data-testid="link-clube"]`).click();
    await expect(page.getByTestId("ticker")).toHaveText(TICKER);
    await expect(page.getByTestId("preco")).toContainText(reais(preco));
    await expect(page.getByTestId("variacao")).toContainText("0,00%");
    // 18: no máximo 5 preços de cada lado, e nenhum apelido no livro
    expect(await page.getByTestId("nivel-compra").count()).toBeLessThanOrEqual(5);
    expect(await page.getByTestId("nivel-venda").count()).toBeLessThanOrEqual(5);
    const textoDoLivro = limpo(await page.locator("section", { hasText: "Livro de ofertas" }).first().innerText());
    expect(textoDoLivro).not.toMatch(/ana|bia|semeador/i);
  });

  test("e2e livro 6 e 14: a boleta recusa preço fora da faixa e quantidade ou preço que não existem", async ({ page }) => {
    await entrarComo(page, "ana");
    await page.goto(`/clube?t=${TICKER}`);
    const revisar = page.getByRole("button", { name: "Revisar compra" });
    await expect(page.getByTestId("faixa")).toContainText("R$");
    // 6: um centavo acima da faixa de +20% é recusado, e o do limite é aceito
    const teto = Math.floor(preco * 1.2);
    await preencher(page, "10", campo(teto + 1));
    await expect(page.getByTestId("erro-boleta")).toBeVisible();
    await expect(revisar).toBeDisabled();
    await preencher(page, "10", campo(teto));
    await expect(page.getByTestId("erro-boleta")).toHaveCount(0);
    await expect(revisar).toBeEnabled();
    // 14: zero ação, ação quebrada e preço com meio centavo não passam
    for (const [q, p] of [["0", campo(preco)], ["1,5", campo(preco)], ["10", `${campo(preco)}5`]]) {
      await preencher(page, q!, p);
      await expect(revisar, `${q} a ${p}`).toBeDisabled();
    }
  });

  test("e2e livro 1 e 16: compra limitada fica no livro com a reserva, aparece destacada e o cancelamento a tira", async ({ page }) => {
    await entrarComo(page, "ana");
    await page.goto(`/clube?t=${TICKER}`);
    const antes = (await livro("ana")).me!.freeCash;
    const limite = Math.floor(preco * 0.9);
    await preencher(page, "100", campo(limite));
    await expect(page.getByTestId("resumo")).toContainText(reais(100 * limite));
    await enviar(page, "Revisar compra");
    await expect(page.getByTestId("enviada")).toContainText("Ordem enviada");
    await expect(page.getByTestId("ordem")).toHaveCount(1);
    await expect(page.locator('[data-testid="nivel-compra"][data-mine="true"]')).toHaveCount(1);
    expect((await livro("ana")).me!.freeCash).toBe(antes - 100 * limite);
    await page.getByTestId("ordem").getByRole("button", { name: /Cancelar/ }).click();
    await expect(page.getByTestId("sem-ordens")).toBeVisible();
    expect((await livro("ana")).me!.freeCash).toBe(antes);
  });

  test("e2e livro 2, 19 e 20: compra a mercado da casa vira negócio sem nome de comprador, e o preço do dia muda", async ({ page }) => {
    await entrarComo(page, "ana");
    await page.goto(`/clube?t=${TICKER}`);
    await page.getByRole("button", { name: "A mercado" }).click();
    await preencher(page, "20");
    await enviar(page, "Revisar compra");
    await expect(page.getByTestId("enviada")).toBeVisible();
    await expect(page.getByTestId("negocio").first()).toBeVisible();
    expect(await page.getByTestId("negocio").count()).toBeLessThanOrEqual(20);
    expect(limpo(await page.getByTestId("negocio").first().innerText())).not.toMatch(/ana|bia|semeador|comprador|vendedor/i);
    expect((await livro("ana")).me!.freeShares).toBe(20);
  });

  test("e2e livro 13 e 15: ordem contra si mesma é recusada; a 51ª ordem aberta também", async ({ page }) => {
    await entrarComo(page, "ana");
    await page.goto(`/clube?t=${TICKER}`);
    const atual = (await livro("ana")).price.displayed;
    // 13: a venda de 20 ações a um preço acima do mercado fica aberta; uma compra limitada no mesmo preço seria contra si mesma
    const alto = Math.floor(atual * 1.1);
    expect((await api("ana", "POST", "/orders", { ticker: TICKER, side: "sell", type: "limit", quantity: 20, limitPrice: alto })).status).toBeLessThan(300);
    await page.reload();
    await preencher(page, "5", campo(alto));
    await expect(page.getByTestId("erro-boleta")).toBeVisible();
    await expect(page.getByRole("button", { name: "Revisar compra" })).toBeDisabled();
    // e a API recusa igual, se a tela for contornada
    expect((await api("ana", "POST", "/orders", { ticker: TICKER, side: "buy", type: "limit", quantity: 5, limitPrice: alto })).status).toBeGreaterThanOrEqual(400);
    // 15: 50 ordens abertas no total (a venda já é uma): a 51ª é recusada e, cancelando uma, a próxima passa
    const baixo = Math.floor(atual * 0.85);
    for (let i = 0; i < 49; i++) {
      const r = await api("ana", "POST", "/orders", { ticker: TICKER, side: "buy", type: "limit", quantity: 1, limitPrice: baixo });
      expect(r.status, `ordem ${i + 2}`).toBeLessThan(300);
    }
    await page.reload();
    await expect(page.getByTestId("ordens-abertas")).toContainText("50 de 50");
    await preencher(page, "1", campo(baixo));
    await expect(page.getByTestId("erro-boleta")).toBeVisible();
    expect((await api("ana", "POST", "/orders", { ticker: TICKER, side: "buy", type: "limit", quantity: 1, limitPrice: baixo })).status).toBeGreaterThanOrEqual(400);
    await page.getByTestId("ordem").first().getByRole("button", { name: /Cancelar/ }).click();
    await expect(page.getByTestId("ordens-abertas")).toContainText("49 de 50");
    await preencher(page, "1", campo(baixo));
    await enviar(page, "Revisar compra");
    await expect(page.getByTestId("enviada")).toBeVisible();
  });

  test("e2e livro 35: com o livro aberto, a ordem de outro jogador aparece na tela sem recarregar", async ({ browser }) => {
    const contexto = await browser.newContext();
    const observador = await contexto.newPage();
    await entrarComo(observador, "ana");
    await observador.goto(`/clube?t=${TICKER}`);
    await expect(observador.getByTestId("ticker")).toHaveText(TICKER);
    const niveis = await observador.getByTestId("nivel-compra").count();
    const atual = (await livro("ana")).price.displayed;
    // um preço de compra novo, que ainda não está no livro, cria um nível novo para quem olha
    const preco = Math.floor(atual * 0.8) + 7;
    const r = await api("bia", "POST", "/orders", { ticker: TICKER, side: "buy", type: "limit", quantity: 3, limitPrice: preco });
    expect(r.status).toBeLessThan(300);
    await expect.poll(async () => observador.getByTestId("nivel-compra").count(), { timeout: 15_000 }).toBeGreaterThan(Math.min(niveis, 4));
    await expect(observador.getByTestId("compras")).toContainText(campo(preco));
    await contexto.close();
  });

  test("e2e livro 27: com o clube em jogo a lista avisa \"Em jogo agora\" e a revisão da ordem também", async ({ page }) => {
    // 2025-03-29 18h30 de Brasília é o primeiro jogo da temporada
    test.setTimeout(300_000); // avançar seis dias pelas tarefas de produção leva de 1 a 2 minutos
    const agora = await avancarRelogio("2025-03-29T21:45:00Z");
    expect(agora).toContain("2025-03-29");
    await sincronizar(page);
    await entrarComo(page, "bia"); // a ana já está no limite de 50 ordens abertas
    await page.goto("/mercado");
    await expect(page.getByTestId("estado-jogo").first()).toBeVisible();
    const jogando = await page.locator('[data-testid="clube"]', { has: page.getByTestId("estado-jogo") }).first().getAttribute("data-ticker");
    await page.goto(`/clube?t=${jogando}`);
    await expect(page.getByTestId("chip-jogo")).toBeVisible();
    await preencher(page, "1", campo((await livro("bia", jogando!)).price.displayed));
    await page.getByRole("button", { name: "Revisar compra" }).click();
    await expect(page.getByTestId("revisao-jogo")).toContainText("Em jogo agora");
  });
  test("e2e livro 38: a tela do clube traz o cartão Quanto vale o FLA3 para você e o simulador refaz a conta ao mudar a aposta", async ({ page }) => {
    await entrarComo(page, "ana");
    await page.goto(`/clube?t=${TICKER}`);
    const cartao = page.getByTestId("valor-cartao");
    await expect(cartao.getByRole("heading", { name: "Quanto vale o FLA3 para você?" })).toBeVisible();
    await expect(cartao.getByTestId("valor-pago")).toBeVisible();
    await expect(cartao.getByTestId("valor-recompra-hoje")).toContainText("R$");
    // a conta aparece pronta e muda quando o jogador aposta mais pontos
    const antes = await cartao.getByTestId("sim-faltam").innerText();
    const pontos = cartao.getByLabel(/Pontos do .* no fim do/);
    await pontos.fill("90");
    await expect(cartao.getByTestId("sim-erro")).toHaveCount(0);
    await expect(cartao.getByTestId("sim-faltam")).not.toHaveText(antes);
    await expect(cartao.getByTestId("sim-valor")).toContainText("R$");
    // aposta que não faz sentido é recusada com o motivo
    await pontos.fill("abc");
    await expect(cartao.getByTestId("sim-erro")).toContainText("número inteiro");
  });
});
