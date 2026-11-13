import { z } from "zod";
import { TICKER_PATTERN } from "../realtime/channels.js";

/** Como a pessoa entra: a carteira índice (padrão) ou só o caixa. */
export const ENTRY_MODES = ["index", "cash"] as const;
export type EntryModeChoice = (typeof ENTRY_MODES)[number];

/** Em que pé está a entrada para esta pessoa (Plano da entrada no meio da temporada, "Disponibilidade e janela"). */
export const ENTRY_AVAILABILITIES = [
  "not_open_yet",
  "settling",
  "open",
  "market_suspended",
  "window_closed",
  "already_entered",
] as const;
export type EntryAvailability = (typeof ENTRY_AVAILABILITIES)[number];

/** O texto em português de cada estado (a tela mostra o do servidor). `market_suspended` leva o motivo do admin. */
export const ENTRY_AVAILABILITY_MESSAGES: Record<Exclude<EntryAvailability, "open">, string> = {
  not_open_yet: "O IPO ainda não fechou: as ofertas do IPO valem para todos até lá.",
  settling: "Estamos fechando o IPO, tente de novo em instantes.",
  market_suspended: "O mercado está suspenso. Volte depois.",
  window_closed: "A entrada no meio da temporada acabou: sua conta entra no IPO do ano seguinte.",
  already_entered: "Você já tem carteira nesta temporada.",
};

/** Uma linha da carteira índice: o preço de referência e a quantidade de cada clube. */
export const entryClubSchema = z.strictObject({
  ticker: z.string().regex(TICKER_PATTERN),
  price: z.number().int(),
  shares: z.number().int(),
});
export type EntryClub = z.infer<typeof entryClubSchema>;

export const entryQuoteSchema = z.strictObject({
  /** Ações de cada clube (zero quando a soma dos preços passa de R$ 70.000,00). */
  n: z.number().int(),
  sum: z.number().int(),
  cash: z.number().int(),
  stockValue: z.number().int(),
  clubCount: z.number().int(),
  clubs: z.array(entryClubSchema),
});
export type EntryQuoteView = z.infer<typeof entryQuoteSchema>;

/** `GET /entry/preview`: não trava nada e vale o preço do momento da leitura. */
export const entryPreviewSchema = z.strictObject({
  availability: z.enum(ENTRY_AVAILABILITIES),
  message: z.string().optional(),
  /** Só em `open`: a carteira índice vem marcada. */
  defaultMode: z.literal("index").optional(),
  /** Só em `open`. */
  quote: entryQuoteSchema.optional(),
  /** Só em `already_entered` quando a carteira veio da entrada no meio. */
  mode: z.enum(ENTRY_MODES).optional(),
});
export type EntryPreview = z.infer<typeof entryPreviewSchema>;

/** `POST /entry`. */
export const enterBodySchema = z.strictObject({ mode: z.enum(ENTRY_MODES) });
export type EnterBody = z.infer<typeof enterBodySchema>;

/** O resultado final da entrada (201), ou o guardado (200, `repeated: true`). */
export const enterResultSchema = z.strictObject({
  mode: z.enum(ENTRY_MODES),
  n: z.number().int(),
  sum: z.number().int(),
  cash: z.number().int(),
  stockValue: z.number().int(),
  enteredAt: z.string(),
  repeated: z.boolean(),
  clubs: z.array(entryClubSchema),
});
export type EnterResult = z.infer<typeof enterResultSchema>;
