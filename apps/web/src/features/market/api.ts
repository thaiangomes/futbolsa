import {
  bookViewSchema,
  cancelOrderResponseSchema,
  clubFixturesSchema,
  clubListSchema,
  clubValueViewSchema,
  listOrdersResponseSchema,
  type PlaceOrderBody,
  placeOrderBodySchema,
  placeOrderResponseSchema,
  type ReplaceOrderBody,
  replaceOrderBodySchema,
  replaceOrderResponseSchema,
  type ProjectionBody,
  projectionBodySchema,
  projectionListSchema,
  projectionSchema,
} from "@futbolsa/contracts";
import type { ApiClient } from "../../lib/api";

/** As rotas do mercado da F9, tipadas pelos contratos (a resposta é conferida pelo esquema zod). */
export function marketApi(api: ApiClient) {
  return {
    /** A lista dos clubes com preço, variação e avisos; pública. */
    clubs: () => api.request(clubListSchema, "/clubs"),
    /** O livro, os negócios, o preço e o estado do clube; público (logado, vem também a faixa e o saldo livre). */
    book: (ticker: string) => api.request(bookViewSchema, `/clubs/${encodeURIComponent(ticker)}/book`),
    /** Os próximos jogos agendados do clube, em todas as competições; público. */
    fixtures: (ticker: string) => api.request(clubFixturesSchema, `/clubs/${encodeURIComponent(ticker)}/fixtures`),
    /** O que o cartão "Quanto vale para você" precisa (pago, a receber, pontos, fases das copas e valores da temporada); público. */
    dividends: (ticker: string) => api.request(clubValueViewSchema, `/clubs/${encodeURIComponent(ticker)}/dividends`),
    /** Envia a ordem. A `Idempotency-Key` é uma por envio: repetir a chamada não duplica a ordem. */
    placeOrder: (body: PlaceOrderBody, idempotencyKey: string) =>
      api.request(placeOrderResponseSchema, "/orders", {
        method: "POST",
        body: placeOrderBodySchema.parse(body),
        headers: { "Idempotency-Key": idempotencyKey },
      }),
    /** As projeções do próprio jogador por clube (critérios 54 a 56); privadas, só logado. */
    projections: () => api.request(projectionListSchema, "/me/projections"),
    /** Salva (ou troca) a projeção do jogador para o clube. */
    saveProjection: (ticker: string, body: ProjectionBody) =>
      api.request(projectionSchema, `/me/projections/${encodeURIComponent(ticker)}`, { method: "PUT", body: projectionBodySchema.parse(body) }),
    /** Edita o preço e a quantidade de uma ordem limitada aberta: troca atômica (critérios 57 a 59). A chave vale por edição. */
    replaceOrder: (id: number, body: ReplaceOrderBody, idempotencyKey: string) =>
      api.request(replaceOrderResponseSchema, `/orders/${id}`, {
        method: "PUT",
        body: replaceOrderBodySchema.parse(body),
        headers: { "Idempotency-Key": idempotencyKey },
      }),
    cancelOrder: (id: number) => api.request(cancelOrderResponseSchema, `/orders/${id}`, { method: "DELETE" }),
    openOrders: () => api.request(listOrdersResponseSchema, "/orders?status=open"),
  };
}

export type MarketApi = ReturnType<typeof marketApi>;
