import { z } from "zod";
import { isoInstantSchema } from "./common.js";

/** Os motivos que impedem o encerramento (um por pendência), os mesmos de `closeBlockers` do motor. */
export const closeBlockerCodeSchema = z.enum([
  "buyback_not_closed",
  "matches_unscored",
  "payouts_pending",
  "payouts_settling",
  "corrections_pending",
  "buyback_not_approved",
  "open_orders",
  "shares_remaining",
  "recalc_pending",
  "fraud_open",
]);
export type CloseBlockerCodeValue = z.infer<typeof closeBlockerCodeSchema>;

export const closeBlockerSchema = z.strictObject({
  code: closeBlockerCodeSchema,
  count: z.number().int().min(1),
  /** O que falta, em português, para a tela. */
  text: z.string(),
  /** A tela do admin onde se resolve (caminho do front), ou `null`. */
  link: z.string().nullable(),
});
export type CloseBlocker = z.infer<typeof closeBlockerSchema>;

/** `GET /admin/seasons/:id/close`: a lista do que falta e o que vai acontecer. */
export const seasonClosePreviewSchema = z.strictObject({
  seasonId: z.number().int(),
  year: z.number().int(),
  status: z.enum(["preparing", "trading", "trading_ended", "closed"]),
  blockers: z.array(closeBlockerSchema),
  canClose: z.boolean(),
  summary: z.strictObject({
    /** Carteiras da temporada (jogadores, bots e tesouraria) que vão a R$ 0,00. */
    wallets: z.number().int(),
    /** Caixa total, em centavos, que some no encerramento. */
    totalCash: z.number().int(),
    /** O 1º do anual parcial (patrimônio de agora), ou `null`. */
    leader: z.strictObject({ nickname: z.string(), equity: z.number().int() }).nullable(),
  }),
});
export type SeasonClosePreview = z.infer<typeof seasonClosePreviewSchema>;

/** `POST /admin/seasons/:id/close`: o admin digita o ano da temporada (Admin, critério 38). */
export const seasonCloseBodySchema = z.strictObject({ confirmYear: z.number().int() });
export type SeasonCloseBody = z.infer<typeof seasonCloseBodySchema>;

export const seasonCloseResponseSchema = z.strictObject({
  seasonId: z.number().int(),
  closedAt: isoInstantSchema,
  wallets: z.number().int(),
  results: z.number().int(),
});
export type SeasonCloseResponse = z.infer<typeof seasonCloseResponseSchema>;

/** Recusa `season_close_blocked`: a mesma lista da prévia. */
export const seasonCloseBlockedSchema = z.strictObject({ blockers: z.array(closeBlockerSchema) });
