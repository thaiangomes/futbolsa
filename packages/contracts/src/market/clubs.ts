import { z } from "zod";
import { marketStateSchema } from "./book.js";
import { auctionStateSchema } from "./orders.js";

/**
 * `GET /clubs` (D6 do Plano do livro de ofertas e formador): a lista dos clubes da temporada com o preço, a variação
 * do dia e os avisos "em jogo agora", "em leilão até 15h40" e "suspenso". Pública. `seq` é o do canal `prices`, lido
 * antes do banco: a tela aplica por cima os eventos `price` com `seq` maior.
 */
export const clubListItemSchema = z.strictObject({
  ticker: z.string(),
  name: z.string(),
  division: z.enum(["A", "B"]),
  /** O preço exibido (o último negócio; antes do primeiro, o de corte do IPO). */
  price: z.number().int(),
  /** Variação desde o preço exibido às 0h de Brasília, em centésimos de ponto percentual. */
  changeBp: z.number().int(),
  /** O clube está no modo de jogo da casa. */
  matchMode: z.boolean(),
  auction: auctionStateSchema.nullable(),
  /** Suspensão do clube (ou do mercado todo), com o motivo que todos veem. */
  suspended: z.strictObject({ reason: z.string() }).nullable(),
});
export type ClubListItem = z.infer<typeof clubListItemSchema>;

export const clubListSchema = z.strictObject({
  seq: z.number().int(),
  market: marketStateSchema,
  clubs: z.array(clubListItemSchema),
});
export type ClubList = z.infer<typeof clubListSchema>;
