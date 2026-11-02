import { normalizeEmail } from "../../infra/auth-adapter/index.js";

/** Configuração das contas, lida das variáveis de ambiente na subida (os testes trocam o provedor). */
export abstract class AccountsConfig {
  /** E-mail do primeiro admin: cria a conta sem convite, já como admin (decisão do Thaian em 2026-11-01). */
  abstract readonly bootstrapAdminEmail: string | null;
}

export function accountsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AccountsConfig {
  const email = env.ADMIN_BOOTSTRAP_EMAIL?.trim();
  return { bootstrapAdminEmail: email ? normalizeEmail(email) : null };
}
