import { mailerFromEnv, SmtpMailer } from "./mailer.js";

const ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/**
 * A conferência do envio de e-mail (`npm run mail:check -w apps/api -- destinatario@exemplo.com`): manda **um** e-mail de
 * teste pelo `Mailer` do ambiente, com o `SMTP_URL` e o `MAIL_FROM` de lá. Devolve o que mostrar na tela, sem nunca repetir a
 * URL, o usuário nem a senha. Lança com a causa se o envio falhar.
 */
export async function runMailCheck(env: NodeJS.ProcessEnv, to: string | undefined): Promise<string> {
  if (!to || !ADDRESS.test(to)) throw new Error("Informe o destinatário: npm run mail:check -w apps/api -- destinatario@exemplo.com");
  if (!env.SMTP_URL?.trim()) throw new Error("SMTP_URL não está definida no ambiente (veja o README da API): sem ela o e-mail só vai para o log.");
  const mailer = mailerFromEnv(env);
  if (!(mailer instanceof SmtpMailer)) throw new Error("O ambiente não montou o SMTP.");
  await mailer.send({
    to,
    subject: "FutBolsa: teste de envio de e-mail",
    text: "Este é um e-mail de teste do FutBolsa. Se você o recebeu, o SMTP da API está configurado.",
  });
  return "E-mail de teste enviado ao servidor SMTP. Confira a caixa de entrada (e o spam) do destinatário.";
}
