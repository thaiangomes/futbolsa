import { z } from "zod";
import { auctionStateSchema } from "../market/orders.js";

/** O clube como as telas da carteira o mostram: ticker, nome e as cores e a sigla do selo (opcionais, sem escudo oficial). */
export const portfolioClubSchema = z.strictObject({
  ticker: z.string(),
  name: z.string(),
  badgeAbbr: z.string().nullable(),
  colorPrimary: z.string().nullable(),
  colorSecondary: z.string().nullable(),
  /** O padrão do selo (`solido`, `listras`, `aros`…), a cor da sigla e a segunda cor do tricolor. */
  badgePattern: z.string().nullable(),
  badgeInk: z.string().nullable(),
  badgeExtra: z.string().nullable(),
});
export type PortfolioClub = z.infer<typeof portfolioClubSchema>;

/** Uma posição aberta (só clubes com ações). Dinheiro em centavos; porcentagens em décimos de ponto percentual. */
export const positionViewSchema = z.strictObject({
  club: portfolioClubSchema,
  shares: z.number().int(),
  /** Ações presas em ordens de venda abertas. */
  inOrders: z.number().int(),
  free: z.number().int(),
  averagePrice: z.number().int(),
  cost: z.number().int(),
  /** O preço exibido (parado durante o leilão). */
  price: z.number().int(),
  marketValue: z.number().int(),
  unrealized: z.number().int(),
  unrealizedPermille: z.number().int(),
  dividends: z.number().int(),
  receivable: z.number().int(),
  /** Fatia do patrimônio; nulo se o patrimônio for zero ou negativo. */
  shareOfEquityPermille: z.number().int().nullable(),
  /** Leilão do túnel de preço do clube; `until` nulo enquanto está parado pela suspensão. */
  auction: auctionStateSchema.nullable(),
});
export type PositionView = z.infer<typeof positionViewSchema>;

/** O resultado total de cada clube com movimento, inclusive o que já zerou. */
export const clubResultSchema = z.strictObject({
  club: portfolioClubSchema,
  realized: z.number().int(),
  unrealized: z.number().int(),
  dividends: z.number().int(),
  receivable: z.number().int(),
  total: z.number().int(),
});
export type ClubResult = z.infer<typeof clubResultSchema>;

/** `GET /portfolio`: a carteira do jogador logado. */
export const walletViewSchema = z.strictObject({
  /** O `seq` do canal `me`, lido antes do banco: a tela aplica por cima os eventos com `seq` maior. */
  seq: z.number().int(),
  at: z.string(),
  cash: z.strictObject({ total: z.number().int(), reserved: z.number().int(), free: z.number().int() }),
  /** Caixa total negativo (estorno): a tela o põe em destaque. */
  negativeCash: z.boolean(),
  receivable: z.number().int(),
  stocksValue: z.number().int(),
  equity: z.number().int(),
  /** Rentabilidade em centésimos de ponto percentual (1116 = 11,16%) sobre R$ 100.000,00. */
  returnBp: z.number().int(),
  /** A recompra já fechou: as ações valem R$ 0,00. */
  buybackClosed: z.boolean(),
  positions: z.array(positionViewSchema),
  results: z.array(clubResultSchema),
  /** Entre temporadas (a anterior encerrada): o ano encerrado e quando abre o IPO seguinte, se já marcado. */
  between: z.strictObject({ closedYear: z.number().int(), nextIpoOpensAt: z.string().nullable() }).nullable().optional(),
});
export type WalletView = z.infer<typeof walletViewSchema>;
