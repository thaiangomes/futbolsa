import { z } from "zod";

/** `market.suspended`, no canal `season`: o mercado todo (`scope: "market"`) ou um clube parou, com o motivo que todos veem. */
export const marketSuspendedEventSchema = z.strictObject({
  scope: z.enum(["club", "market"]),
  ticker: z.string().nullable(),
  reason: z.string(),
});
export type MarketSuspendedEvent = z.infer<typeof marketSuspendedEventSchema>;

/** `market.resumed`, no canal `season`: a negociação voltou. */
export const marketResumedEventSchema = z.strictObject({
  scope: z.enum(["club", "market"]),
  ticker: z.string().nullable(),
});
export type MarketResumedEvent = z.infer<typeof marketResumedEventSchema>;

/** `admin.pending`, no canal `admin`: quantos jogos já deviam ter terminado e seguem sem placar. */
export const adminPendingEventSchema = z.strictObject({ pendingMatches: z.number().int() });
export type AdminPendingEvent = z.infer<typeof adminPendingEventSchema>;
