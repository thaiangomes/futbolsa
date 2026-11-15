import { decodeJwt, type JWTVerifyGetKey } from "jose";
import type { TestingModuleBuilder } from "@nestjs/testing";
import type { Clock } from "../src/infra/clock/index.js";
import { SystemClock } from "../src/infra/clock/index.js";
import { AuthVerifier, InvalidTokenError, SupabaseAuthVerifier, type AuthIdentity, type IdentityAdmin } from "../src/infra/auth-adapter/index.js";
import { TEST_ISSUER, testVerifier } from "../test/support/auth.js";
import type { FixedClock } from "../src/infra/clock/index.js";

/**
 * O login da partida aberta a convidados (F17, T9, decisão D7): o verificador de verdade (`SupabaseAuthVerifier`) com o projeto
 * Supabase de produção, e só ele para quem vem de fora. Os bots e as contas internas da partida (o admin que carrega a
 * temporada, os 9 perfis) chamam a API por dentro do processo com tokens de uma chave gerada na subida e que nunca sai da
 * memória (`test/support/auth.ts`); o verificador as aceita, mas só quando o emissor do token é o de teste E a assinatura confere
 * com essa chave. Um token de fora com esse emissor falha na assinatura.
 *
 * O prazo do token do Supabase conta no relógio de verdade, não no do jogo (que fica em janeiro de 2026 e pula meses). Pelo mesmo
 * motivo o "último login" (`authenticatedAt`, que a exclusão de conta confere contra o relógio do jogo) é convertido: a idade do
 * login em tempo real vira a mesma idade no relógio do jogo.
 *
 * Duas defesas da revisão de segurança (T10): (1) as contas internas da partida usam e-mails `@exemplo.com`, e a API liga uma
 * identidade nova a qualquer conta com o mesmo e-mail confirmado; por isso o verificador recusa toda identidade do Supabase com
 * esse domínio; (2) a partida **não recebe a chave de serviço** do Supabase de produção: apagar a identidade (exclusão de conta)
 * não faz nada aqui, e a conta de login de produção do convidado fica como estava.
 */

/** O domínio dos e-mails das contas internas da partida (`test/support/accounts.ts`): ninguém entra de fora com ele. */
export const DOMINIO_RESERVADO = "@exemplo.com";

export interface LoginReal {
  /** `https://<projeto>.supabase.co`, o projeto de produção. */
  supabaseUrl: string;
  /** O endereço do site na Vercel: o único que o CORS e o WebSocket aceitam. */
  siteOrigem: string;
  /** Só os testes: chaves públicas no lugar das buscadas no Supabase. */
  chaves?: JWTVerifyGetKey;
  admin?: IdentityAdmin;
}

export class VerificadorDaPartida extends AuthVerifier {
  constructor(
    private readonly interno: AuthVerifier,
    private readonly supabase: AuthVerifier,
    private readonly clockDoJogo: Clock = new SystemClock(),
    private readonly agoraReal: () => number = Date.now,
  ) {
    super();
  }

  async verify(token: string): Promise<AuthIdentity> {
    if (emissorInterno(token)) return this.interno.verify(token);
    const id = await this.supabase.verify(token);
    if (id.email.endsWith(DOMINIO_RESERVADO)) throw new InvalidTokenError("email_reservado");
    const idade = Math.max(0, this.agoraReal() - id.authenticatedAt.getTime());
    return { ...id, authenticatedAt: new Date(this.clockDoJogo.now().getTime() - idade) };
  }

  /** Não apaga nada no Supabase de produção (a partida não tem a chave de serviço). */
  async deleteIdentity(): Promise<void> {}
}

function emissorInterno(token: string): boolean {
  try {
    return decodeJwt(token).iss === TEST_ISSUER;
  } catch {
    return false;
  }
}

/** Valida o que a subida pública exige, com mensagem clara e sem repetir valor secreto. */
export function conferirLoginReal(l: LoginReal): void {
  let supabase: URL;
  let site: URL;
  try {
    supabase = new URL(l.supabaseUrl);
  } catch {
    throw new Error("SUPABASE_URL não é um endereço válido (esperado https://<projeto>.supabase.co).");
  }
  try {
    site = new URL(l.siteOrigem);
  } catch {
    throw new Error("WEB_ORIGIN (o endereço do site na Vercel) não é um endereço válido (esperado https://<nome>.vercel.app).");
  }
  if (supabase.protocol !== "https:") throw new Error("SUPABASE_URL tem que ser https.");
  if (site.hostname !== "localhost" && site.protocol !== "https:") throw new Error("WEB_ORIGIN tem que ser https (o endereço do site na Vercel).");
  if (l.siteOrigem !== site.origin) throw new Error("WEB_ORIGIN é só o endereço do site, sem barra no fim nem caminho (ex.: https://futbolsa-partida.vercel.app).");
}

export function loginReal(l: LoginReal, clockDoJogo: FixedClock) {
  const supabase = new SupabaseAuthVerifier({
    supabaseUrl: l.supabaseUrl.replace(/\/+$/, ""),
    keys: l.chaves,
    clock: new SystemClock(),
    admin: l.admin ?? { deleteUser: async () => undefined },
  });
  const verificador = new VerificadorDaPartida(testVerifier(clockDoJogo), supabase, clockDoJogo);
  return (builder: TestingModuleBuilder) => builder.overrideProvider(AuthVerifier).useValue(verificador);
}
