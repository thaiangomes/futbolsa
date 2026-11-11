import { z } from "zod";
import { adminReasonSchema } from "./common.js";

/**
 * `PATCH /admin/market-maker` (livro 34): muda os percentuais da quantidade da casa e os mínimos por lado, com
 * motivo no registro do admin; vale a partir da reposição seguinte. O lote (`mmLotBp`) só muda antes da
 * abertura do IPO. Pontos-base: 25 = 0,25%.
 */
const basisPoints = z.number().int().min(0).max(10_000);
const minQuantity = z.number().int().min(1);

export const marketMakerBodySchema = z
  .strictObject({
    mmQuantityBp: basisPoints.optional(),
    mmMatchQuantityBp: basisPoints.optional(),
    mmMinSideQty: minQuantity.optional(),
    mmMatchMinSideQty: minQuantity.optional(),
    mmLotBp: basisPoints.optional(),
    reason: adminReasonSchema,
  })
  .refine(
    (b) => [b.mmQuantityBp, b.mmMatchQuantityBp, b.mmMinSideQty, b.mmMatchMinSideQty, b.mmLotBp].some((v) => v !== undefined),
    { message: "Informe ao menos um valor para mudar." },
  );
export type MarketMakerBody = z.infer<typeof marketMakerBodySchema>;

/** Os valores em vigor, devolvidos pela rota (e lidos pela tela). */
export const marketMakerStateSchema = z.strictObject({
  mmQuantityBp: z.number().int(),
  mmMatchQuantityBp: z.number().int(),
  mmMinSideQty: z.number().int(),
  mmMatchMinSideQty: z.number().int(),
  mmLotBp: z.number().int(),
});
export type MarketMakerState = z.infer<typeof marketMakerStateSchema>;

export const MARKET_MAKER_ERROR_MESSAGES = {
  lot_locked: "O lote do formador só muda antes da abertura do IPO.",
  no_season: "Não há temporada em andamento.",
} as const;
