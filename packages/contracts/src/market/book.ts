import { z } from "zod";
import { auctionStateSchema } from "./orders.js";

/**
 * O livro agregado de um clube (F9, "O que o jogador vê"): os 5 melhores preços de cada lado com a quantidade
 * somada e o número de ordens, sem apelido e sem marcar a casa nem os bots; os 20 últimos negócios sem
 * comprador nem vendedor. Todos os esquemas são estritos: um campo de dono não passa.
 */

export const BOOK_DEPTH = 5;
export const RECENT_TRADES = 20;

export const bookLevelSchema = z.strictObject({
  price: z.number().int(),
  quantity: z.number().int(),
  orders: z.number().int(),
});
export type BookLevel = z.infer<typeof bookLevelSchema>;

/** Um negócio como o público o vê: o `id` serve para o cliente descartar repetido e ordenar. */
export const publicTradeSchema = z.strictObject({
  id: z.number().int(),
  at: z.string(),
  price: z.number().int(),
  quantity: z.number().int(),
});
export type PublicTrade = z.infer<typeof publicTradeSchema>;

const levelsSchema = z.array(bookLevelSchema).max(BOOK_DEPTH);

/** `book`, no canal `club:<ticker>`: o estado absoluto do livro (seguro de repetir). */
export const bookEventSchema = z.strictObject({
  /** Melhores compras primeiro (maior preço). */
  bids: levelsSchema,
  /** Melhores vendas primeiro (menor preço). */
  asks: levelsSchema,
  auction: auctionStateSchema.nullable(),
});
export type BookEvent = z.infer<typeof bookEventSchema>;

/** O estado da negociação do clube na tela: aberta, ainda não aberta (abre às 10h), suspensa ou encerrada. */
export const marketStateSchema = z.strictObject({
  state: z.enum(["not_open", "open", "suspended", "ended"]),
  /** Quando a negociação abre (ou abriu). */
  opensAt: z.string().nullable(),
  /** O motivo da suspensão, que todos veem. */
  reason: z.string().nullable(),
});
export type MarketState = z.infer<typeof marketStateSchema>;

/** O que só quem está logado vê: a faixa de 20% e o saldo livre para ordens. */
export const bookMeSchema = z.strictObject({
  band: z.strictObject({ min: z.number().int(), max: z.number().int() }),
  freeCash: z.number().int(),
  freeShares: z.number().int(),
});
export type BookMe = z.infer<typeof bookMeSchema>;

/** `GET /clubs/:ticker/book`. `seq` é o do canal `club:<ticker>`, lido antes do banco (P2 do Plano do WebSocket). */
export const bookViewSchema = z.strictObject({
  ticker: z.string(),
  seq: z.number().int(),
  price: z.strictObject({
    /** O preço exibido: o último negócio (antes do primeiro, o preço do IPO). */
    displayed: z.number().int(),
    /** Variação desde o preço exibido às 0h de Brasília, em centésimos de ponto percentual (+5,00% = 500). */
    changeBp: z.number().int(),
  }),
  /** O clube está no modo de jogo da casa ("em jogo agora"). */
  matchMode: z.boolean(),
  auction: auctionStateSchema.nullable(),
  market: marketStateSchema,
  bids: levelsSchema,
  asks: levelsSchema,
  /** Do mais recente para o mais antigo. */
  trades: z.array(publicTradeSchema).max(RECENT_TRADES),
  me: bookMeSchema.nullable(),
});
export type BookView = z.infer<typeof bookViewSchema>;
