import { z } from "zod";

/**
 * Avisos ao jogador (F14, T20): a anulação de negócios por trapaça e o banimento. Aparecem em `GET /me` até o
 * jogador confirmar a leitura. Nunca citam a outra conta (proposta 22 do Plano do admin de jogadores e bots).
 */

export const noticeKindSchema = z.enum(["fraud_warning", "fraud_ban"]);
export type NoticeKind = z.infer<typeof noticeKindSchema>;

/** Um negócio anulado, como o jogador o vê: sem a contraparte. */
export const noticeTradeSchema = z.strictObject({
  at: z.string(),
  ticker: z.string(),
  quantity: z.number().int(),
  price: z.number().int(),
  /** `quantidade × preço`, em centavos. */
  value: z.number().int(),
});
export type NoticeTrade = z.infer<typeof noticeTradeSchema>;

export const noticeBodySchema = z.strictObject({
  /** O motivo escrito pelo admin. */
  reason: z.string(),
  /** Os negócios anulados (vazio no aviso de banimento). */
  trades: z.array(noticeTradeSchema),
});
export type NoticeBody = z.infer<typeof noticeBodySchema>;

export const pendingNoticeSchema = z.strictObject({
  id: z.number().int(),
  kind: noticeKindSchema,
  createdAt: z.string(),
  body: noticeBodySchema,
});
export type PendingNotice = z.infer<typeof pendingNoticeSchema>;

/** `POST /me/notices/:id/read`: confirma a leitura; repetir não muda o horário. */
export const readNoticeResponseSchema = z.strictObject({ readAt: z.string() });
export type ReadNoticeResponse = z.infer<typeof readNoticeResponseSchema>;

export const NOTICE_ERROR_MESSAGES = {
  notice_not_found: "Aviso não encontrado.",
} as const;
export type NoticeErrorCode = keyof typeof NOTICE_ERROR_MESSAGES;
