import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import {
  adjustBodySchema,
  type AdjustBody,
  type AdjustResponse,
  blockBodySchema,
  type BlockBody,
  type BlockResponse,
  deletePlayerBodySchema,
  type DeletePlayerBody,
  type DeletePlayerResponse,
  entriesQuerySchema,
  type EntriesQuery,
  type EntriesResponse,
  type PlayerDetail,
  type PlayersList,
  playersQuerySchema,
  type PlayersQuery,
} from "@futbolsa/contracts";
import { AdminOnly, CurrentUser, type ResolvedUser } from "../../../infra/auth-adapter/index.js";
import { DomainError, ZodValidationPipe } from "../../../infra/http/index.js";
import { ADMIN_ERROR_MESSAGES } from "@futbolsa/contracts";
import { idempotencyKeySchema } from "../../market/orders/idempotency.js";
import { AdjustService } from "./adjust.service.js";
import { BlockService } from "./block.service.js";
import { AdminDeleteService } from "./delete.service.js";
import { PlayersQueryService } from "./players.query.js";

const idPipe = new ZodValidationPipe(z.uuid());

/** Jogadores pelo admin (T2 a T5 da F14): ver, bloquear, excluir e ajustar saldo. Tudo só para admin ativo. */
@AdminOnly()
@Controller("admin/players")
export class PlayersController {
  constructor(
    private readonly query: PlayersQueryService,
    private readonly blocks: BlockService,
    private readonly deletes: AdminDeleteService,
    private readonly adjusts: AdjustService,
  ) {}

  @Get()
  list(@Query(new ZodValidationPipe(playersQuerySchema)) q: PlayersQuery): Promise<PlayersList> {
    return this.query.list(q);
  }

  @Get(":id")
  detail(@Param("id", idPipe) id: string): Promise<PlayerDetail> {
    return this.query.detail(id);
  }

  @Get(":id/entries")
  entries(@Param("id", idPipe) id: string, @Query(new ZodValidationPipe(entriesQuerySchema)) q: EntriesQuery): Promise<EntriesResponse> {
    return this.query.entries(id, q);
  }

  @HttpCode(200)
  @Post(":id/block")
  block(
    @CurrentUser() admin: ResolvedUser,
    @Param("id", idPipe) id: string,
    @Body(new ZodValidationPipe(blockBodySchema)) body: BlockBody,
  ): Promise<BlockResponse> {
    return this.blocks.block(admin.id, id, body.reason);
  }

  @HttpCode(200)
  @Post(":id/unblock")
  unblock(
    @CurrentUser() admin: ResolvedUser,
    @Param("id", idPipe) id: string,
    @Body(new ZodValidationPipe(blockBodySchema)) body: BlockBody,
  ): Promise<BlockResponse> {
    return this.blocks.unblock(admin.id, id, body.reason);
  }

  /** A exclusão não tem volta; responde 202 porque a carteira pode ficar para depois da liquidação do IPO. */
  @HttpCode(202)
  @Delete(":id")
  remove(
    @CurrentUser() admin: ResolvedUser,
    @Param("id", idPipe) id: string,
    @Body(new ZodValidationPipe(deletePlayerBodySchema)) body: DeletePlayerBody,
  ): Promise<DeletePlayerResponse> {
    return this.deletes.delete(admin.id, id, body);
  }

  @HttpCode(200)
  @Post(":id/adjust")
  adjust(
    @CurrentUser() admin: ResolvedUser,
    @Param("id", idPipe) id: string,
    @Headers("idempotency-key") idempotencyKey: unknown,
    @Body(new ZodValidationPipe(adjustBodySchema)) body: AdjustBody,
  ): Promise<AdjustResponse> {
    const key = idempotencyKeySchema.safeParse(idempotencyKey);
    if (!key.success) throw new DomainError("idempotency_key_required", 400, ADMIN_ERROR_MESSAGES.idempotency_key_required);
    return this.adjusts.adjust(admin.id, id, body, key.data);
  }
}
