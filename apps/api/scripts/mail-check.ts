import { runMailCheck } from "../src/infra/mail/check.js";

// Manda um e-mail de teste com o SMTP_URL do ambiente (nunca com credencial neste arquivo):
//   npm run mail:check -w apps/api -- destinatario@exemplo.com
try {
  console.log(await runMailCheck(process.env, process.argv[2]));
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
