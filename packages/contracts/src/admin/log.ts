import { z } from "zod";

/** Filtros e página do `GET /admin/log`. */
export const adminLogQuerySchema = z.strictObject({
  actorId: z.uuid().optional(),
  action: z.string().min(1).max(60).optional(),
  /** Do instante dado (inclusive). */
  from: z.iso.datetime({ offset: true }).optional(),
  /** Até o instante dado (exclusive). */
  to: z.iso.datetime({ offset: true }).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
export type AdminLogQuery = z.infer<typeof adminLogQuerySchema>;

export const adminLogEntrySchema = z.strictObject({
  id: z.number().int(),
  actor: z.strictObject({ id: z.string(), nickname: z.string().nullable() }),
  at: z.string(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  before: z.unknown(),
  after: z.unknown(),
  reason: z.string().nullable(),
});
export type AdminLogEntryView = z.infer<typeof adminLogEntrySchema>;

export const adminLogResponseSchema = z.strictObject({
  entries: z.array(adminLogEntrySchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});
export type AdminLogResponse = z.infer<typeof adminLogResponseSchema>;
