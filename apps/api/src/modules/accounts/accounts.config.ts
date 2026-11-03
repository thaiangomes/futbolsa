import { createHmac, randomBytes } from "node:crypto";
import { Logger } from "@nestjs/common";
import { normalizeEmail } from "../../infra/auth-adapter/index.js";

/** Configuração das contas, lida das variáveis de ambiente na subida (os testes trocam o provedor). */
export abstract class AccountsConfig {
  /** E-mail do primeiro admin: cria a conta sem convite, já como admin (decisão do Thaian em 2026-11-01). */
  abstract readonly bootstrapAdminEmail: string | null;
  /** Segredo do e-mail embaralhado no registro do admin. */
  abstract readonly adminLogEmailKey: string;
}

export function accountsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AccountsConfig {
  const email = env.ADMIN_BOOTSTRAP_EMAIL?.trim();
  let key = env.ADMIN_LOG_EMAIL_KEY?.trim();
  if (!key) {
    // Sem a chave, o registro continua sem e-mail, mas um e-mail não pode ser conferido depois.
    new Logger("Contas").warn("ADMIN_LOG_EMAIL_KEY vazio: o registro do admin usa uma chave que some ao reiniciar");
    key = randomBytes(32).toString("hex");
  }
  return { bootstrapAdminEmail: email ? normalizeEmail(email) : null, adminLogEmailKey: key };
}

/**
 * O e-mail embaralhado para o registro do admin, que não se apaga: confere um e-mail conhecido
 * sem guardá-lo, e a exclusão da conta não deixa o e-mail para trás (decisão do Thaian em
 * 2026-11-01, proposta 6 do Plano de login e contas).
 */
export function emailFingerprint(key: string, email: string): string {
  return `hmac:${createHmac("sha256", key).update(normalizeEmail(email)).digest("hex").slice(0, 32)}`;
}
