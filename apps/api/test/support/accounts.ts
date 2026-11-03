import { randomUUID } from "node:crypto";
import type { UserRole, UserStatus } from "@futbolsa/contracts";
import type { Database } from "../../src/infra/db/index.js";
import { authIdentities, users } from "../../src/infra/db/schema/index.js";
import { type TokenOptions, tokenFor } from "./auth.js";

export interface TestAccount {
  id: string;
  /** O `sub` da identidade ligada. */
  subject: string;
  email: string;
  nickname: string;
  /** Um token válido dessa pessoa (no instante padrão `TOKEN_T0`). */
  token: string;
  /** Outro token da mesma pessoa, com opções. */
  tokenWith(options?: Omit<TokenOptions, "subject" | "email">): Promise<string>;
}

let counter = 0;

/**
 * Cria uma conta do jogo já cadastrada (usuário e identidade ligada), sem passar pelo
 * `POST /me`. Para os testes de qualquer fase que precise de um jogador ou de um admin logado.
 */
export async function createAccount(
  db: Database,
  o: { nickname?: string; email?: string; role?: UserRole; status?: UserStatus; at?: Date } = {},
): Promise<TestAccount> {
  counter++;
  const nickname = o.nickname ?? `jog_${counter}_${randomUUID().slice(0, 6)}`;
  const email = (o.email ?? `${nickname}@exemplo.com`).toLowerCase();
  const subject = randomUUID();
  const [user] = await db
    .insert(users)
    .values({
      email: o.status === "deleted" ? null : email,
      nickname: o.status === "deleted" ? null : nickname,
      role: o.role ?? "player",
      status: o.status ?? "active",
      termsAcceptedAt: o.at ?? new Date("2027-03-20T12:00:00Z"),
      deletedAt: o.status === "deleted" ? (o.at ?? new Date("2027-03-21T12:00:00Z")) : null,
    })
    .returning({ id: users.id });
  await db.insert(authIdentities).values({ provider: "supabase", subject, userId: user!.id });
  const tokenWith = (options: Omit<TokenOptions, "subject" | "email"> = {}) => tokenFor({ ...options, subject, email });
  return { id: user!.id, subject, email, nickname, token: await tokenWith(), tokenWith };
}
