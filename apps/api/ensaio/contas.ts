import { createAccount, type TestAccount } from "../test/support/accounts.js";
import { bearer } from "../test/support/auth.js";
import type { Database } from "../src/infra/db/index.js";
import type { ServidorEnsaio } from "./servidor.js";

/** Uma conta do ensaio e o token dela no relógio de agora (o token vence em 1 hora do relógio simulado). */
export interface ContaEnsaio {
  conta: TestAccount;
  /** Cabeçalho de autorização com token novo, emitido no instante simulado. */
  auth(): Promise<{ authorization: string }>;
}

export async function criarConta(
  db: Database,
  servidor: Pick<ServidorEnsaio, "clock">,
  opcoes: { nickname?: string; role?: "player" | "admin" } = {},
): Promise<ContaEnsaio> {
  const conta = await createAccount(db, { nickname: opcoes.nickname, role: opcoes.role, at: servidor.clock.now() });
  return { conta, auth: async () => bearer(await conta.tokenWith({ at: servidor.clock.now() })) };
}
