import { z } from "zod";
import { adminReasonSchema } from "./common.js";

/** `POST /admin/suspensions`: um clube (com `ticker`) ou o mercado todo (sem `ticker`). */
export const suspendBodySchema = z.strictObject({
  ticker: z
    .string()
    .regex(/^[A-Z]{3,5}\d{1,2}$/)
    .optional(),
  reason: adminReasonSchema,
});
export type SuspendBody = z.infer<typeof suspendBodySchema>;

export const suspensionStateSchema = z.strictObject({
  market: z.strictObject({ reason: z.string() }).nullable(),
  clubs: z.array(z.strictObject({ ticker: z.string(), reason: z.string() })),
});
export type SuspensionState = z.infer<typeof suspensionStateSchema>;
