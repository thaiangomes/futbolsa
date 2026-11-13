import { Injectable, Logger } from "@nestjs/common";
import { parseSmtpUrl, sendSmtp, type SmtpSettings } from "./smtp-client.js";

/** Um e-mail de texto simples. */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * Envio de e-mail da API (T26 da F14). O Supabase só manda os e-mails dele (confirmação e recuperação de senha); os do
 * jogo, como o aviso de trapaça, saem por aqui. Trocável, como o adaptador de login: `SmtpMailer` de verdade e
 * `LogMailer` para desenvolvimento e testes. Quem envia nunca desfaz nada por falha: lança, e quem chamou tenta de novo.
 */
export abstract class Mailer {
  abstract send(message: MailMessage): Promise<void>;
}

/**
 * Sem `SMTP_URL`, o e-mail só vira uma linha no log, **sem** endereço nem texto (só o assunto), para o log nunca guardar
 * dado pessoal nem segredo. As últimas mensagens ficam na memória (`outbox`) para os testes conferirem.
 */
@Injectable()
export class LogMailer extends Mailer {
  private readonly logger = new Logger("E-mail");
  readonly outbox: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.outbox.push(message);
    if (this.outbox.length > 100) this.outbox.shift();
    this.logger.log(`e-mail registrado, não enviado (sem SMTP_URL): "${message.subject}"`);
  }
}

/** SMTP de verdade: `SMTP_URL` (`smtp://usuario:senha@servidor:587`, ou `smtps://` para TLS direto) e `MAIL_FROM`. */
@Injectable()
export class SmtpMailer extends Mailer {
  constructor(private readonly settings: SmtpSettings) {
    super();
  }

  send(message: MailMessage): Promise<void> {
    return sendSmtp(this.settings, message);
  }
}

/** O `Mailer` do ambiente: com `SMTP_URL`, o SMTP; sem, o que só registra. O segredo fica só no ambiente. */
export function mailerFromEnv(env: NodeJS.ProcessEnv = process.env): Mailer {
  const url = env.SMTP_URL?.trim();
  if (!url) return new LogMailer();
  return new SmtpMailer(parseSmtpUrl(url, env.MAIL_FROM?.trim() || "FutBolsa <nao-responda@futbolsa.invalid>"));
}
