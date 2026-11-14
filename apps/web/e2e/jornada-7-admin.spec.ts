import { expect, test } from "@playwright/test";
import { api, entrarComo, prepararCenario } from "./support/controle";

/**
 * Jornada 7 (T21): o administrador pela tela: o que pede atenção, a suspensão e o bloqueio de um jogador, e o jogador comum
 * barrado. Prefixo `e2e admin N` (T24). Os fluxos de pagamentos, correção com estorno e trapaça entre contas dependem de rodadas
 * fechadas e de negócios suspeitos e ficam no ensaio (T11 e T12); aqui só se confere que as telas abrem sem erro.
 */
const MOTIVO = "Placar errado na fonte, conferindo com a CBF";

test.describe.serial("jornada 7: admin", () => {
  test.beforeAll(async () => {
    await prepararCenario("negociacao", ["ana", "bia"]);
  });

  test("e2e admin 35 e 31: o jogador comum é barrado em toda tela do admin, e a API recusa", async ({ page }) => {
    await entrarComo(page, "ana");
    for (const rota of ["/admin", "/admin/suspensao", "/admin/jogadores", "/admin/pagamentos"]) {
      await page.goto(rota);
      await expect(page.locator("body"), rota).toContainText("Só o admin pode ver esta página.");
    }
    expect((await api("ana", "GET", "/admin/players")).status).toBe(403);
    expect((await api("ana", "POST", "/admin/suspensions", { scope: "market", reason: MOTIVO })).status).toBeGreaterThanOrEqual(400);
  });

  test("e2e admin 1 e 2: a visão geral lista o que pede atenção e as telas de pendências, pagamentos e trapaça abrem", async ({ page }) => {
    await entrarComo(page, "admin");
    await page.goto("/admin");
    await expect(page.getByText("O que pede atenção", { exact: false }).first()).toBeVisible();
    await expect(page.locator("main")).toContainText("Classificação por conferir");
    for (const [rota, titulo] of [
      ["/admin/jogos", "Jogos e pendências"],
      ["/admin/pagamentos", "Pagamentos de dividendos"],
      ["/admin/pagamentos/correcao", "Correção de pagamentos"],
      ["/admin/trapaca", "Trapaça entre contas"],
      ["/admin/negocios", "Auditoria de negócios"],
      ["/admin/registro", "Registro do admin"],
    ] as const) {
      await page.goto(rota);
      await expect(page.getByRole("heading", { name: titulo }).first(), rota).toBeVisible();
      await expect(page.locator(".note-err"), rota).toHaveCount(0);
    }
  });

  test("e2e admin 23 e 24: suspender um clube mostra o motivo a todos, deixa as ordens no livro, e retomar volta ao normal", async ({ page, browser }) => {
    // uma ordem da bia no FLA3 antes da suspensão
    const livro = (await api<{ price: { displayed: number } }>("bia", "GET", "/clubs/FLA3/book")).corpo;
    const limite = Math.floor(livro.price.displayed * 0.9);
    expect((await api("bia", "POST", "/orders", { ticker: "FLA3", side: "buy", type: "limit", quantity: 5, limitPrice: limite })).status).toBeLessThan(300);

    await entrarComo(page, "admin");
    await page.goto("/admin/suspensao");
    await page.getByRole("button", { name: "Um clube" }).click();
    await page.getByLabel("Ticker do clube").fill("FLA3");
    await page.getByLabel("Motivo (todos os jogadores veem)").fill(MOTIVO);
    await page.getByRole("button", { name: "Suspender" }).click();
    await expect(page.getByRole("button", { name: "Retomar FLA3" })).toBeVisible();

    const jogador = await (await browser.newContext()).newPage();
    await entrarComo(jogador, "bia");
    await jogador.goto("/clube?t=FLA3");
    await expect(jogador.getByTestId("chip-suspenso")).toBeVisible();
    await expect(jogador.locator("body")).toContainText(MOTIVO);
    // a ordem aberta continua no livro e pode ser cancelada (24); ordem nova é recusada
    await expect(jogador.getByTestId("ordem")).toHaveCount(1);
    const nova = await api("bia", "POST", "/orders", { ticker: "FLA3", side: "buy", type: "limit", quantity: 1, limitPrice: limite });
    expect(nova.status).toBeGreaterThanOrEqual(400);

    await page.getByRole("button", { name: "Retomar FLA3" }).click();
    await expect(page.getByRole("button", { name: "Retomar FLA3" })).toHaveCount(0);
    await jogador.reload();
    await expect(jogador.getByTestId("chip-suspenso")).toHaveCount(0);
    expect((await api("bia", "POST", "/orders", { ticker: "FLA3", side: "buy", type: "limit", quantity: 1, limitPrice: limite })).status).toBeLessThan(300);
    await jogador.context().close();
  });

  test("e2e admin 25: bloquear um jogador cancela as ordens e o impede de negociar; desbloquear devolve", async ({ page }) => {
    await entrarComo(page, "admin");
    await page.goto("/admin/jogadores");
    await page.getByLabel("Começo do apelido ou e-mail exato").fill("bia");
    await page.getByRole("button", { name: "Buscar", exact: true }).click();
    await page.getByRole("link", { name: "bia" }).click();
    await expect(page.getByRole("heading", { name: "Bloquear" }).or(page.getByText("Bloquear").first())).toBeVisible();
    await page.locator("#motivo-bloqueio").fill(MOTIVO);
    await page.getByRole("button", { name: "Bloquear", exact: true }).click();
    await expect(page.getByRole("button", { name: "Desbloquear", exact: true })).toBeVisible();
    // as ordens abertas saíram, e o bloqueado não negocia
    const ordens = await api<Array<{ status: string }> | { orders: Array<{ status: string }> }>("bia", "GET", "/orders");
    const lista = Array.isArray(ordens.corpo) ? ordens.corpo : ordens.corpo.orders;
    expect(lista.filter((o) => o.status === "open")).toEqual([]);
    expect((await api("bia", "POST", "/orders", { ticker: "FLA3", side: "buy", type: "market", quantity: 1 })).status).toBeGreaterThanOrEqual(400);
    await page.locator("#motivo-bloqueio").fill("Conferido, foi engano");
    await page.getByRole("button", { name: "Desbloquear", exact: true }).click();
    await expect(page.getByRole("button", { name: "Bloquear", exact: true })).toBeVisible();
  });
});
