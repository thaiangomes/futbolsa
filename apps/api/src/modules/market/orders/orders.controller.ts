import { Body, Controller, Delete, Get, Headers, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import {
  type CancelOrderResponse,
  type ListOrdersResponse,
  listOrdersQuerySchema,
  type PlaceOrderBody,
  placeOrderBodySchema,
  type PlaceOrderResponse,
} from "@futbolsa/contracts";
import { CurrentUser, type ResolvedUser } from "../../../infra/auth-adapter/index.js";
import { RateLimit, ZodValidationPipe } from "../../../infra/http/index.js";
import { parseIdempotencyKey } from "./idempotency.js";
import { PlayerOrdersService } from "./player-orders.service.js";

/** O id da ordem na rota: inteiro positivo (as ordens começam em 1). */
const orderIdPipe = new ZodValidationPipe(z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER));

/**
 * As ordens do próprio jogador (T5 e T6 do Plano do livro de ofertas e formador). Login padrão do jogo: sem token dá
 * 401 e o e-mail sem confirmar dá 403 `email_not_confirmed` no guard (Conta e login, 5). O bloqueado passa no guard e
 * lê as próprias ordens; quem recusa a ordem dele é o serviço, com a carteira travada. Limite `orders` do throttler,
 * por pessoa (60 por minuto em cada rota).
 */
@RateLimit("orders")
@Controller("orders")
export class OrdersController {
  constructor(private readonly orders: PlayerOrdersService) {}

  /** Uma ordem nova. Aceita o cabeçalho `Idempotency-Key` (a mesma chave com o mesmo corpo devolve a mesma resposta). */
  @Post()
  place(
    @CurrentUser() user: ResolvedUser,
    @Body(new ZodValidationPipe(placeOrderBodySchema)) body: PlaceOrderBody,
    @Headers("idempotency-key") idempotencyKey: unknown,
  ): Promise<PlaceOrderResponse> {
    return this.orders.place(user.id, body, parseIdempotencyKey(idempotencyKey));
  }

  /** As ordens abertas do próprio jogador (`?status=open`, o único filtro por enquanto). */
  @Get()
  list(@CurrentUser() user: ResolvedUser, @Query(new ZodValidationPipe(listOrdersQuerySchema)) _query: unknown): Promise<ListOrdersResponse> {
    return this.orders.listOpen(user.id);
  }

  /** Cancela uma ordem aberta do próprio jogador e devolve a reserva. */
  @Delete(":id")
  cancel(@CurrentUser() user: ResolvedUser, @Param("id", orderIdPipe) id: number): Promise<CancelOrderResponse> {
    return this.orders.cancel(user.id, id);
  }
}
