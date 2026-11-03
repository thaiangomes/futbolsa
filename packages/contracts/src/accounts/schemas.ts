import { z } from "zod";

/**
 * Apelidos que ninguém escolhe, em qualquer combinação de maiúsculas, para ninguém se passar
 * pela casa, pelo jogo ou por uma conta excluída nos rankings (Conta e login, critério 25;
 * decisão do Thaian em 2026-11-01).
 */
export const RESERVED_NICKNAMES = ["casa", "admin", "tesouraria", "futbolsa", "bot", "conta_excluida"] as const;

/** O apelido está na lista de reservados, sem diferenciar maiúsculas. */
export function isReservedNickname(nickname: string): boolean {
  return (RESERVED_NICKNAMES as readonly string[]).includes(nickname.toLowerCase());
}

/**
 * Apelido: de 3 a 20 caracteres, só letras sem acento, números e `_` (Conta e login,
 * critério 9). A unicidade sem diferenciar maiúsculas e os reservados são conferidos pela
 * API, com `nickname_taken` e `nickname_reserved`; a tela usa `isReservedNickname` para avisar antes.
 */
export const nicknameSchema = z
  .string()
  .min(3, "O apelido tem de 3 a 20 caracteres.")
  .max(20, "O apelido tem de 3 a 20 caracteres.")
  .regex(/^[A-Za-z0-9_]+$/, "Use só letras sem acento, números e _.");

export const userRoleSchema = z.enum(["player", "admin"]);
export type UserRole = z.infer<typeof userRoleSchema>;

export const userStatusSchema = z.enum(["active", "blocked", "deleted"]);
export type UserStatus = z.infer<typeof userStatusSchema>;

export const seasonStatusSchema = z.enum(["preparing", "ipo_open", "ipo_closed", "trading", "trading_ended", "closed"]);

/**
 * `GET /me`. Sem conta do jogo, só se o e-mail **da própria pessoa** está liberado. Com conta,
 * o e-mail aparece só aqui, para o dono (critério 11), e a situação da temporada atual.
 */
export const meResponseSchema = z.discriminatedUnion("registered", [
  z.strictObject({ registered: z.literal(false), invited: z.boolean() }),
  z.strictObject({
    registered: z.literal(true),
    id: z.string(),
    nickname: z.string(),
    email: z.string(),
    role: userRoleSchema,
    status: userStatusSchema,
    termsAcceptedAt: z.string(),
    season: z
      .strictObject({
        year: z.number().int(),
        status: seasonStatusSchema,
        ipoOpensAt: z.string().nullable(),
        /** Tem carteira nesta temporada. */
        hasWallet: z.boolean(),
        /** Conta criada depois do fechamento do IPO, ainda sem carteira: vai para a entrada no meio. */
        needsEntry: z.boolean(),
      })
      .nullable(),
  }),
]);
export type MeResponse = z.infer<typeof meResponseSchema>;

/**
 * `POST /me`: o cadastro. Só apelido e o aceite dos termos e da política: nada de nome nem de
 * idade (critérios 2, 20 e 21). Campo a mais é recusado.
 */
export const createMeBodySchema = z.strictObject({
  nickname: nicknameSchema,
  acceptTerms: z.literal(true, "Aceite os termos de uso e a política de privacidade."),
});
export type CreateMeBody = z.infer<typeof createMeBodySchema>;

/** `PATCH /me/nickname`. */
export const patchNicknameBodySchema = z.strictObject({ nickname: nicknameSchema });
export type PatchNicknameBody = z.infer<typeof patchNicknameBodySchema>;

/** `DELETE /me`: confirma digitando o apelido atual. */
export const deleteMeBodySchema = z.strictObject({ confirmNickname: z.string().min(1).max(20) });
export type DeleteMeBody = z.infer<typeof deleteMeBodySchema>;

/** Resposta do `DELETE /me`: a carteira é encerrada na hora ou logo depois da liquidação do IPO. */
export const deleteMeResponseSchema = z.strictObject({ walletCloseout: z.enum(["done", "after_ipo_settlement"]) });
export type DeleteMeResponse = z.infer<typeof deleteMeResponseSchema>;

/** `GET /players/:nickname`, público: só o apelido (critério 11). */
export const publicPlayerSchema = z.strictObject({ nickname: z.string() });
export type PublicPlayer = z.infer<typeof publicPlayerSchema>;

const emailSchema = z.email("E-mail inválido.").max(254);

/** `POST /admin/invites`: de 1 a 200 e-mails. */
export const invitesBodySchema = z.strictObject({ emails: z.array(emailSchema).min(1).max(200) });
export type InvitesBody = z.infer<typeof invitesBodySchema>;

export const inviteSchema = z.strictObject({
  email: z.string(),
  createdAt: z.string(),
  usedAt: z.string().nullable(),
});
export type Invite = z.infer<typeof inviteSchema>;

export const invitesResponseSchema = z.strictObject({ invites: z.array(inviteSchema) });

/** Resultado do `POST /admin/invites`: os liberados agora e os e-mails que já têm conta. */
export const invitesCreatedSchema = z.strictObject({
  invited: z.array(z.string()),
  alreadyInvited: z.array(z.string()),
  alreadyRegistered: z.array(z.string()),
});

/** `PATCH /admin/players/:id/role`, com motivo obrigatório (Admin, critério 33). */
export const patchRoleBodySchema = z.strictObject({
  role: userRoleSchema,
  reason: z.string().trim().min(3).max(500),
});
export type PatchRoleBody = z.infer<typeof patchRoleBodySchema>;
