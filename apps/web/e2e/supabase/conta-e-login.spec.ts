import { randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";

/**
 * Conta e login no Supabase de verdade (T23). Critérios de Conta e login: 4, 6, 7, 26 e 27 (o 26 sem o "outro aparelho", que
 * o token de acesso de 1 hora impede de ver na hora: veja o README). Google e a caixa de e-mail ficam no roteiro manual da A11.
 *
 * A conta de teste é criada e apagada pela chave de serviço (que só existe no ambiente deste processo); o link de nova senha
 * vem do `admin.generateLink`, no lugar do e-mail. Nenhum e-mail real é enviado: o cadastro pelo formulário só é conferido
 * até o botão (sem enviar), e a confirmação de e-mail já vem feita pela chave de serviço.
 */
const SENHA_VELHA = `Velha-${randomBytes(6).toString("hex")}`;
const SENHA_NOVA = `Nova-${randomBytes(6).toString("hex")}`;
const EMAIL = `futbolsa-e2e-${randomBytes(4).toString("hex")}@example.com`;
const EMAIL_SEM_CONTA = `futbolsa-e2e-ninguem-${randomBytes(4).toString("hex")}@example.com`;
const SITE = process.env.E2E_SUPABASE_SITE!;

let supabase: SupabaseClient;
let userId: string | undefined;

async function convidar(email: string) {
  const c = new pg.Client({ connectionString: process.env.E2E_SUPABASE_DATABASE_URL });
  await c.connect();
  try {
    await c.query("insert into futbolsa.invites (email) values ($1) on conflict do nothing", [email.toLowerCase()]);
  } finally {
    await c.end();
  }
}

async function entrar(page: Page, email: string, senha: string) {
  await page.goto("/entrar");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
}

test.describe.serial("conta e login no Supabase de verdade", () => {
  test.beforeAll(async () => {
    supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await supabase.auth.admin.createUser({ email: EMAIL, password: SENHA_VELHA, email_confirm: true });
    if (error) throw new Error(`não criei a conta de teste: ${error.message}`);
    userId = data.user.id;
    await convidar(EMAIL);
  });

  test.afterAll(async () => {
    // a conta de teste nunca fica no projeto, mesmo se um teste falhar
    if (userId) await supabase.auth.admin.deleteUser(userId);
  });

  test("e2e conta 4: a senha de 7 caracteres é recusada na criação do login, e a de 8 é aceita", async ({ page }) => {
    await page.goto("/criar-conta");
    await page.getByLabel("E-mail").fill(EMAIL_SEM_CONTA);
    const criar = page.getByRole("button", { name: "Criar login" });
    await page.getByLabel("Senha", { exact: true }).fill("1234567");
    await page.getByLabel("Repita a senha").fill("1234567");
    await expect(criar).toBeDisabled();
    await page.getByLabel("Senha", { exact: true }).fill("12345678");
    await page.getByLabel("Repita a senha").fill("12345678");
    await expect(criar).toBeEnabled();
    // não envia: criar o login mandaria e-mail de verdade
  });

  test("e2e conta 6: senha errada e e-mail sem conta dão a mesma mensagem no Supabase de verdade", async ({ page }) => {
    const aviso = async () => (await page.getByRole("alert").filter({ hasText: /./ }).first().innerText()).trim();
    await entrar(page, EMAIL, "senha-errada-123");
    const errada = await aviso();
    await entrar(page, EMAIL_SEM_CONTA, "senha-errada-123");
    const semConta = await aviso();
    expect(errada).toBe(semConta);
    expect(errada).toMatch(/E-mail ou senha incorretos/);
  });

  test("e2e conta 7: o link de nova senha cria outra senha, e a antiga deixa de funcionar", async ({ page }) => {
    const { data, error } = await supabase.auth.admin.generateLink({ type: "recovery", email: EMAIL, options: { redirectTo: `${SITE}/nova-senha` } });
    if (error) throw new Error(error.message);
    await page.goto(data.properties.action_link);
    await expect(page.getByRole("heading", { name: "Crie a senha nova" })).toBeVisible({ timeout: 30_000 });
    await page.getByLabel("Senha nova").fill(SENHA_NOVA);
    await page.getByLabel("Repita a senha").fill(SENHA_NOVA);
    await page.getByRole("button", { name: "Gravar senha" }).click();
    await expect(page.getByRole("heading", { name: "Senha trocada" })).toBeVisible();
    // a antiga recusa; a nova entra (e cai no cadastro, porque a conta de teste ainda não escolheu apelido)
    await page.evaluate(() => window.localStorage.clear());
    await entrar(page, EMAIL, SENHA_VELHA);
    await expect(page.getByRole("alert").filter({ hasText: /incorretos/ })).toBeVisible();
    await entrar(page, EMAIL, SENHA_NOVA);
    await expect(page).toHaveURL(/cadastro|mercado|conta|carteira|\/$/);
  });

  test("e2e conta 26: trocar a senha logado grava a nova, recusa a de 7 caracteres, e a nova entra", async ({ page }) => {
    await entrar(page, EMAIL, SENHA_NOVA);
    await page.goto("/cadastro");
    await page.getByLabel("Apelido").fill(`e2e_${randomBytes(3).toString("hex")}`);
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Criar conta" }).click();
    await expect(page.getByText("Sua conta foi criada")).toBeVisible();
    await page.goto("/conta");
    await page.getByRole("button", { name: /Trocar senha/ }).click();
    const outra = `Outra-${randomBytes(6).toString("hex")}`;
    await page.getByLabel(/Senha nova/).fill("1234567");
    await expect(page.getByRole("button", { name: "Gravar senha" })).toBeDisabled();
    await page.getByLabel(/Senha nova/).fill(outra);
    await page.getByRole("button", { name: "Gravar senha" }).click();
    await expect(page.getByRole("status").filter({ hasText: /senha/i }).first()).toBeVisible();
    await page.evaluate(() => window.localStorage.clear());
    await entrar(page, EMAIL, outra);
    await expect(page).not.toHaveURL(/entrar/);
  });

  test("e2e conta 27: quem entra sem senha (link mágico, como o Google) cria uma senha na tela da conta e passa a entrar por e-mail", async ({ page }) => {
    const email = `futbolsa-e2e-sem-senha-${randomBytes(4).toString("hex")}@example.com`;
    const criado = await supabase.auth.admin.createUser({ email, email_confirm: true });
    if (criado.error) throw new Error(criado.error.message);
    try {
      await convidar(email);
      const { data, error } = await supabase.auth.admin.generateLink({ type: "magiclink", email, options: { redirectTo: `${SITE}/auth/retorno` } });
      if (error) throw new Error(error.message);
      await page.goto(data.properties.action_link);
      await page.waitForURL(/cadastro|mercado|conta|carteira|\/$/, { timeout: 30_000 });
      await page.goto("/cadastro");
      await page.getByLabel("Apelido").fill(`e2e_${randomBytes(3).toString("hex")}`);
      await page.getByRole("checkbox").check();
      await page.getByRole("button", { name: "Criar conta" }).click();
      await expect(page.getByText("Sua conta foi criada")).toBeVisible();
      await page.goto("/conta");
      await page.getByRole("button", { name: /Criar senha/ }).click();
      const senha = `Criada-${randomBytes(6).toString("hex")}`;
      await page.getByLabel(/Senha \(mínimo 8 caracteres\)/).fill(senha);
      await page.getByRole("button", { name: "Gravar senha" }).click();
      await expect(page.getByRole("status").filter({ hasText: /senha/i }).first()).toBeVisible();
      await page.evaluate(() => window.localStorage.clear());
      await entrar(page, email, senha);
      await expect(page).not.toHaveURL(/entrar/);
    } finally {
      await supabase.auth.admin.deleteUser(criado.data.user.id);
    }
  });
});
