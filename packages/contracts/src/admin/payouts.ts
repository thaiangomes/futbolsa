import { z } from "zod";
import { adminReasonSchema, clubRefSchema, competitionSchema, isoInstantSchema } from "./common.js";

/**
 * Pagamentos de dividendos do admin (Admin, "Pagamento de dividendos" e "Correção depois de pago";
 * Dividendos e recompra). Dinheiro sempre em centavos inteiros.
 */

export const payoutStatusSchema = z.enum(["pending", "approved", "superseded"]);
export type PayoutStatusCode = z.infer<typeof payoutStatusSchema>;

export const payoutKindSchema = z.enum(["points", "placement", "promotion", "cup_phase", "cup_title", "buyback"]);
export type PayoutKindCode = z.infer<typeof payoutKindSchema>;

/**
 * Como anda a liquidação de um evento aprovado: `not_started` (ainda aguarda aprovação ou foi substituído),
 * `settling` (aprovado, e há carteira sem crédito) e `settled` (cada carteira com valor tem a linha do crédito).
 */
export const settlementStateSchema = z.enum(["not_started", "settling", "settled"]);

// ---------- GET /admin/payouts ----------

export const payoutListQuerySchema = z.strictObject({
  status: payoutStatusSchema.optional(),
  competition: competitionSchema.optional(),
  round: z.coerce.number().int().min(1).optional(),
  phase: z.string().min(1).max(40).optional(),
});
export type PayoutListQuery = z.infer<typeof payoutListQuerySchema>;

export const payoutEventViewSchema = z.strictObject({
  id: z.number().int(),
  /** A chave estável do evento entre as versões, por exemplo `points|brasileirao-a|16|FLA3`. */
  key: z.string(),
  kind: payoutKindSchema,
  club: clubRefSchema,
  competition: competitionSchema.nullable(),
  round: z.number().int().nullable(),
  phase: z.string().nullable(),
  /** Por exemplo "6 pontos, rodada 16, 12 (adiado)". */
  reason: z.string(),
  /** Valor por ação, em centavos. */
  perShare: z.number().int(),
  /** O fechamento, que define quem recebe. */
  closedAt: isoInstantSchema,
  status: payoutStatusSchema,
  version: z.number().int(),
  approvedAt: isoInstantSchema.nullable(),
  /** Ações da foto: a tesouraria fica fora, e a conta excluída não conta (não recebe). */
  shares: z.strictObject({ players: z.number().int(), bots: z.number().int(), total: z.number().int() }),
  /** `shares.total × perShare`. */
  total: z.number().int(),
  /** Só na colocação e no acesso: se a classificação oficial já foi conferida; `null` nos outros tipos. */
  standingsConfirmed: z.boolean().nullable(),
  settlement: z.strictObject({
    state: settlementStateSchema,
    /** Carteiras que já têm a linha do crédito. */
    credited: z.number().int(),
    /** Carteiras com valor a receber. */
    expected: z.number().int(),
  }),
});
export type PayoutEventView = z.infer<typeof payoutEventViewSchema>;

export const payoutListResponseSchema = z.strictObject({ events: z.array(payoutEventViewSchema) });
export type PayoutListResponse = z.infer<typeof payoutListResponseSchema>;

// ---------- GET /admin/payouts/:id/holders ----------

export const payoutHoldersQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
export type PayoutHoldersQuery = z.infer<typeof payoutHoldersQuerySchema>;

export const payoutHolderSchema = z.strictObject({
  walletId: z.number().int(),
  /** `bot` vem marcado; `deleted` é a conta excluída, que não recebe. */
  kind: z.enum(["player", "bot", "deleted"]),
  nickname: z.string().nullable(),
  shares: z.number().int(),
  /** O que ela recebe (ações × valor por ação); zero para a conta excluída. */
  amount: z.number().int(),
  /** O que já foi creditado por este evento; `null` se ainda não saiu. */
  credited: z.number().int().nullable(),
});
export type PayoutHolder = z.infer<typeof payoutHolderSchema>;

export const payoutHoldersResponseSchema = z.strictObject({
  holders: z.array(payoutHolderSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});
export type PayoutHoldersResponse = z.infer<typeof payoutHoldersResponseSchema>;

// ---------- POST /admin/payouts/approve ----------

/** Uma lista de eventos, ou `all: true` para todos os pendentes. */
export const approvePayoutsBodySchema = z.union([
  z.strictObject({ eventIds: z.array(z.number().int().positive()).min(1).max(500) }),
  z.strictObject({ all: z.literal(true) }),
]);
export type ApprovePayoutsBody = z.infer<typeof approvePayoutsBodySchema>;

export const approveOutcomeSchema = z.enum([
  "approved",
  "already_approved",
  "event_superseded",
  "standings_not_confirmed",
  "not_found",
]);
export type ApproveOutcome = z.infer<typeof approveOutcomeSchema>;

export const approvePayoutsResponseSchema = z.strictObject({
  results: z.array(z.strictObject({ eventId: z.number().int(), outcome: approveOutcomeSchema })),
});
export type ApprovePayoutsResponse = z.infer<typeof approvePayoutsResponseSchema>;

// ---------- GET e POST /admin/payouts/corrections ----------

/** O que a correção faz com a diferença: entra na correção, ou só refaz um pendente. */
export const correctionOutcomeSchema = z.enum(["correction", "new_in_paid_group", "vanished"]);

export const correctionChangeSchema = z.strictObject({
  key: z.string(),
  kind: payoutKindSchema,
  club: clubRefSchema,
  competition: competitionSchema.nullable(),
  round: z.number().int().nullable(),
  phase: z.string().nullable(),
  reason: z.string(),
  /** Valor por ação antes e depois, e a diferença (`after − before`: positivo é complemento, negativo é estorno). */
  before: z.number().int(),
  after: z.number().int(),
  delta: z.number().int(),
  closedAtBefore: isoInstantSchema.nullable(),
  closedAtAfter: isoInstantSchema.nullable(),
  /**
   * Ações na foto do evento (jogadores e bots, sem a conta excluída e a tesouraria): a foto que paga o valor novo
   * (a do fechamento novo, se ele mudou), ou a original no evento que sumiu.
   */
  shares: z.number().int(),
  /**
   * O que a correção move em R$ no evento: `shares × delta` quando o fechamento não muda; com o fechamento mudado,
   * o estorno do valor antigo pela foto antiga mais o pagamento do novo pela foto nova.
   */
  total: z.number().int(),
  /** `correction`: valor ou fechamento mudou; `new_in_paid_group`: evento novo numa rodada ou fase já paga; `vanished`: sumiu (vira R$ 0,00). */
  outcome: correctionOutcomeSchema,
});
export type CorrectionChange = z.infer<typeof correctionChangeSchema>;

export const correctionPreviewSchema = z.strictObject({
  /** Identifica o plano: aplicar com um código velho dá `correction_stale`. */
  planCode: z.string().min(1),
  changes: z.array(correctionChangeSchema),
  wallets: z.strictObject({
    /** Carteiras que recebem a mais. */
    receive: z.number().int(),
    /** Carteiras que devolvem. */
    pay: z.number().int(),
    /** Carteiras que ficam com o caixa negativo. */
    negative: z.number().int(),
    /** Compras abertas que serão canceladas para cobrir o estorno. */
    buysCancelled: z.number().int(),
  }),
  /** Meses de ranking afetados (`2027-04`), inclusive os já fechados. */
  months: z.array(z.string()),
});
export type CorrectionPreview = z.infer<typeof correctionPreviewSchema>;

export const applyCorrectionBodySchema = z.strictObject({
  planCode: z.string().min(1),
  reason: adminReasonSchema,
});
export type ApplyCorrectionBody = z.infer<typeof applyCorrectionBodySchema>;

/**
 * Resposta do `POST /admin/payouts/corrections`: as versões novas gravadas já aprovadas (a etapa 1). Os estornos e
 * complementos saem depois, em lotes por carteira, e a prévia dos pagamentos mostra "liquidando" até acabar.
 */
export const applyCorrectionResponseSchema = z.strictObject({
  planCode: z.string().min(1),
  events: z.array(
    z.strictObject({
      /** A versão nova, já `approved`. */
      eventId: z.number().int(),
      key: z.string(),
      ticker: z.string(),
      version: z.number().int(),
      /** A versão substituída; `null` no evento novo numa rodada ou fase já paga. */
      supersedesId: z.number().int().nullable(),
      perShare: z.number().int(),
    }),
  ),
  /** O resumo por carteira da prévia aplicada. */
  wallets: correctionPreviewSchema.shape.wallets,
});
export type ApplyCorrectionResponse = z.infer<typeof applyCorrectionResponseSchema>;

/** O 409 `correction_stale`: a prévia nova vai junto, para a tela mostrar o que mudou (sem ela, só se não deu para calcular). */
export const correctionStaleResponseSchema = z.strictObject({
  code: z.literal("correction_stale"),
  message: z.string(),
  preview: correctionPreviewSchema.optional(),
});
export type CorrectionStaleResponse = z.infer<typeof correctionStaleResponseSchema>;

// ---------- tempo real ----------

/** `payout.credited`, no canal `me`: um crédito, complemento ou estorno de pagamento chegou à carteira. */
export const payoutCreditedEventSchema = z.strictObject({
  eventId: z.number().int(),
  kind: z.enum(["dividend", "reversal", "complement"]),
  ticker: z.string(),
  reason: z.string(),
  /** Positivo cai no caixa; negativo é o estorno. */
  amount: z.number().int(),
});
export type PayoutCreditedEvent = z.infer<typeof payoutCreditedEventSchema>;
