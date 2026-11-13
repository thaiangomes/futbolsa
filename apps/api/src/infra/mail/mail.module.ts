import { Global, Module } from "@nestjs/common";
import { Mailer, mailerFromEnv } from "./mailer.js";

/** O `Mailer` da API, global: com `SMTP_URL` envia de verdade, sem ela só registra no log. */
@Global()
@Module({
  providers: [{ provide: Mailer, useFactory: () => mailerFromEnv() }],
  exports: [Mailer],
})
export class MailModule {}
