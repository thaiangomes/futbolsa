import {
  bookViewSchema,
  cancelOrderResponseSchema,
  clubListSchema,
  listOrdersResponseSchema,
  type PlaceOrderBody,
  placeOrderBodySchema,
  placeOrderResponseSchema,
} from "@futbolsa/contracts";
import type { ApiClient } from "../../lib/api";

/** As rotas do mercado da F9, tipadas pelos contratos (a resposta é conferida pelo esquema zod). */
export function marketApi(api: ApiClient) {
  return {
    /** A lista dos clubes com preço, variação e avisos; pública. */
    clubs: () => api.request(clubListSchema, "/clubs"),
    /** O livro, os negócios, o preço e o estado do clube; público (logado, vem também a faixa e o saldo livre). */
    book: (ticker: string) => api.request(bookViewSchema, `/clubs/${encodeURIComponent(ticker)}/book`),
    /** Envia a ordem. A `Idempotency-Key` é uma por envio: repetir a chamada não duplica a ordem. */
    placeOrder: (body: PlaceOrderBody, idempotencyKey: string) =>
      api.request(placeOrderResponseSchema, "/orders", {
        method: "POST",
        body: placeOrderBodySchema.parse(body),
        headers: { "Idempotency-Key": idempotencyKey },
      }),
    cancelOrder: (id: number) => api.request(cancelOrderResponseSchema, `/orders/${id}`, { method: "DELETE" }),
    openOrders: () => api.request(listOrdersResponseSchema, "/orders?status=open"),
  };
}

export type MarketApi = ReturnType<typeof marketApi>;
