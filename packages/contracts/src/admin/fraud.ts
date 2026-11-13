import { z } from "zod";
import { TICKER_PATTERN } from "../realtime/channels.js";
import { adminReasonSchema, isoInstantSchema } from "./common.js";

/**
 * Contratos da trapaça entre contas (F14, T20): alertas, relatório, decisão, banimento. Tudo só em `/admin`;
 * nenhuma rota fora dele lê esses dados. Valores em centavos inteiros e horários em ISO 8601.
 */

export const fraudCaseStatusSchema = z.enum(["open", "confirmed", "dismissed"]);
export type FraudCaseStatus = z.infer<typeof fraudCaseStatusSchema>;

export const fraudCaseOriginSchema = z.enum(["alert", "manual"]);
export type FraudCaseOrigin = z.infer<typeof fraudCaseOriginSchema>;

/** Uma conta do caso: jogador (apelido), bot ou conta excluída (sem e-mail nem apelido). */
export const fraudPartySchema = z.strictObject({
  walletId: z.number().int(),
  kind: z.enum(["player", "bot", "deleted"]),
  /** Vazio no bot e na conta excluída. */
  userId: z.uuid().nullable(),
  /** "Ana", "bot momentum #12" ou "conta excluída". */
  label: z.string(),
  /** O e-mail só existe aqui, lido na hora, e some com a exclusão da conta. */
  email: z.string().nullable(),
  /** Advertências desta temporada, antes deste caso. */
  warnings: z.number().int().min(0),
});
export type FraudParty = z.infer<typeof fraudPartySchema>;

/** `GET /admin/fraud/cases?status=&cursor=`. */
export const fraudCasesQuerySchema = z.strictObject({
  status: fraudCaseStatusSchema.optional(),
  cursor: z.string().max(100).optional(),
});
export type FraudCasesQuery = z.infer<typeof fraudCasesQuerySchema>;

export const fraudCaseItemSchema = z.strictObject({
  id: z.number().int(),
  origin: fraudCaseOriginSchema,
  status: fraudCaseStatusSchema,
  /** Vazio no relatório manual de todos os clubes. */
  ticker: z.string().nullable(),
  periodFrom: z.string(),
  periodTo: z.string(),
  openedAt: z.string(),
  decidedAt: z.string().nullable(),
  parties: z.tuple([fraudPartySchema, fraudPartySchema]),
  tradeCount: z.number().int(),
  suspiciousCount: z.number().int(),
});
export type FraudCaseItem = z.infer<typeof fraudCaseItemSchema>;

export const fraudCasesResponseSchema = z.strictObject({
  cases: z.array(fraudCaseItemSchema),
  nextCursor: z.string().nullable(),
});
export type FraudCasesResponse = z.infer<typeof fraudCasesResponseSchema>;

/** `POST /admin/fraud/cases`: o relatório manual, a partir da auditoria. As contas são ids de usuário ou de bot. */
export const fraudAccountRefSchema = z.union([
  z.strictObject({ userId: z.uuid() }),
  z.strictObject({ botId: z.number().int().min(1) }),
]);
export const createFraudCaseBodySchema = z
  .strictObject({
    accountA: fraudAccountRefSchema,
    accountB: fraudAccountRefSchema,
    from: isoInstantSchema,
    to: isoInstantSchema,
    ticker: z.string().regex(TICKER_PATTERN).optional(),
  })
  .refine((b) => Date.parse(b.from) <= Date.parse(b.to), { message: "O período termina antes de começar.", path: ["to"] });
export type CreateFraudCaseBody = z.infer<typeof createFraudCaseBodySchema>;

/** Um negócio do par no período. A conta compradora e a vendedora aparecem pelo `walletId` das `parties`. */
export const fraudReportTradeSchema = z.strictObject({
  id: z.number().int(),
  at: z.string(),
  ticker: z.string(),
  quantity: z.number().int(),
  price: z.number().int(),
  priceBefore: z.number().int(),
  /** Variação sobre o preço anterior, em pontos-base com sinal (700 = alta de 7%). */
  variationBp: z.number().int(),
  inAuction: z.boolean(),
  buyerWalletId: z.number().int(),
  sellerWalletId: z.number().int(),
  suspicious: z.boolean(),
  /** Marcado pelo admin na decisão (só depois de decidido; antes, vazio). */
  selected: z.boolean(),
  /** Já anulado por outro caso: não entra mais na decisão. */
  annulled: z.boolean(),
});
export type FraudReportTrade = z.infer<typeof fraudReportTradeSchema>;

/** Quanto do clube é do par: quantos negócios e quanto da alta ou da queda do preço vem deles. */
export const fraudClubWeightSchema = z.strictObject({
  ticker: z.string(),
  clubTrades: z.number().int(),
  pairTrades: z.number().int(),
  /** O preço no início e no fim do período, com todos os negócios e sem os do par. */
  priceFrom: z.number().int(),
  priceTo: z.number().int(),
  priceToWithoutPair: z.number().int(),
});
export type FraudClubWeight = z.infer<typeof fraudClubWeightSchema>;

/** Um ponto por dia, no máximo 60: o preço com e sem os negócios e o valor justo da casa. */
export const fraudSeriesPointSchema = z.strictObject({
  at: z.string(),
  ticker: z.string(),
  price: z.number().int(),
  priceWithout: z.number().int(),
  fairValue: z.number().int().nullable(),
});
export type FraudSeriesPoint = z.infer<typeof fraudSeriesPointSchema>;

/** Patrimônio e posição no ranking de uma conta no fechamento de um mês (no mês aberto, agora), com e sem. */
export const fraudMonthSchema = z.strictObject({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  at: z.string(),
  /** `true` no mês ainda aberto: o número é de agora. */
  open: z.boolean(),
  accounts: z.array(
    z.strictObject({
      walletId: z.number().int(),
      equity: z.number().int(),
      equityWithout: z.number().int(),
      /** Posição entre os participantes do ranking naquele instante; vazia fora do ranking. */
      rank: z.number().int().nullable(),
      rankWithout: z.number().int().nullable(),
    }),
  ),
});
export type FraudMonth = z.infer<typeof fraudMonthSchema>;

/** A foto do caso: o que o relatório mostra e o que fica guardado na decisão (sem e-mail nem apelido). */
export const fraudReportSchema = z.strictObject({
  trades: z.array(fraudReportTradeSchema),
  clubs: z.array(fraudClubWeightSchema),
  series: z.array(fraudSeriesPointSchema),
  months: z.array(fraudMonthSchema),
  /** Negócios das duas contas com outros jogadores no mesmo clube e período, à parte. */
  others: z.array(
    z.strictObject({
      id: z.number().int(),
      at: z.string(),
      ticker: z.string(),
      quantity: z.number().int(),
      price: z.number().int(),
      /** Qual das duas contas: o `walletId`. */
      walletId: z.number().int(),
      side: z.enum(["buy", "sell"]),
    }),
  ),
});
export type FraudReport = z.infer<typeof fraudReportSchema>;

/** `GET /admin/fraud/cases/:id`: aberto, calculado na hora; decidido, a foto guardada. */
export const fraudCaseDetailSchema = z.strictObject({
  id: z.number().int(),
  origin: fraudCaseOriginSchema,
  status: fraudCaseStatusSchema,
  ticker: z.string().nullable(),
  periodFrom: z.string(),
  periodTo: z.string(),
  openedAt: z.string(),
  openedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decisionReason: z.string().nullable(),
  parties: z.tuple([fraudPartySchema, fraudPartySchema]),
  /** O hash da foto guardada na decisão (vazio com o caso aberto). */
  reportHash: z.string().nullable(),
  report: fraudReportSchema,
});
export type FraudCaseDetail = z.infer<typeof fraudCaseDetailSchema>;

/** `POST /admin/fraud/cases/:id/confirm` (com `Idempotency-Key`): os negócios marcados e o motivo. */
export const confirmFraudBodySchema = z.strictObject({
  tradeIds: z.array(z.number().int().min(1)).min(1).max(500),
  reason: adminReasonSchema,
});
export type ConfirmFraudBody = z.infer<typeof confirmFraudBodySchema>;

/** `POST /admin/fraud/cases/:id/dismiss`. */
export const dismissFraudBodySchema = z.strictObject({ reason: adminReasonSchema });
export type DismissFraudBody = z.infer<typeof dismissFraudBodySchema>;

export const fraudAnnulledTradeSchema = z.strictObject({
  tradeId: z.number().int(),
  /** Ações que voltaram ao vendedor. */
  sharesReturned: z.number().int(),
  /** Ações que ficaram com o comprador (já não as tinha livres). */
  sharesShort: z.number().int(),
  /** Dinheiro que voltou ao comprador. */
  cashReturned: z.number().int(),
});

export const fraudBanOfferSchema = z.strictObject({
  userId: z.uuid(),
  label: z.string(),
  /** Quantas advertências já tinha antes deste caso. */
  previousWarnings: z.number().int().min(1),
});
export type FraudBanOffer = z.infer<typeof fraudBanOfferSchema>;

export const confirmFraudResponseSchema = z.strictObject({
  caseId: z.number().int(),
  status: fraudCaseStatusSchema,
  annulled: z.array(fraudAnnulledTradeSchema),
  /** Contas que já tinham advertência: a tela oferece banir; nada acontece sozinho. */
  banOffer: z.array(fraudBanOfferSchema),
});
export type ConfirmFraudResponse = z.infer<typeof confirmFraudResponseSchema>;

export const dismissFraudResponseSchema = z.strictObject({
  caseId: z.number().int(),
  status: fraudCaseStatusSchema,
});
export type DismissFraudResponse = z.infer<typeof dismissFraudResponseSchema>;

/** `POST /admin/fraud/cases/:id/ban`: só conta do caso com advertência anterior. */
export const banFraudBodySchema = z.strictObject({
  userId: z.uuid(),
  reason: adminReasonSchema,
});
export type BanFraudBody = z.infer<typeof banFraudBodySchema>;

export const banFraudResponseSchema = z.strictObject({
  userId: z.uuid(),
  status: z.literal("blocked"),
});
export type BanFraudResponse = z.infer<typeof banFraudResponseSchema>;

/** Erros novos da trapaça, com a mensagem que a tela mostra. */
export const FRAUD_ERROR_MESSAGES = {
  case_not_found: "Caso não encontrado.",
  case_already_decided: "Este caso já foi decidido.",
  trade_not_annullable: "Algum dos negócios não é deste caso ou já foi anulado.",
  annul_not_allowed: "Neste momento da temporada não dá para anular negócios.",
  club_in_auction: "O clube está em leilão: espere o leilão terminar para anular.",
  ban_not_offered: "Esta conta não tem advertência anterior: o banimento só vale na reincidência.",
  fraud_house_account: "A casa não entra num relatório de trapaça.",
  fraud_same_account: "Escolha duas contas diferentes.",
} as const;
export type FraudErrorCode = keyof typeof FRAUD_ERROR_MESSAGES;
