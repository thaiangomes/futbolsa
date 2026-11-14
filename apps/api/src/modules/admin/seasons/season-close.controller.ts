import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { type SeasonCloseBody, seasonCloseBodySchema, type SeasonClosePreview, type SeasonCloseResponse } from "@futbolsa/contracts";
import { AdminOnly, CurrentUser, type ResolvedUser } from "../../../infra/auth-adapter/index.js";
import { ZodValidationPipe } from "../../../infra/http/index.js";
import { SeasonCloseService } from "./season-close.service.js";

const idPipe = new ZodValidationPipe(z.coerce.number().int().positive());

/**
 * Encerrar a temporada (F15, T6): a prévia (o que falta e o que vai acontecer) e o encerramento, confirmado digitando o
 * ano (Admin, critérios 21, 22 e 38).
 */
@AdminOnly()
@Controller("admin/seasons")
export class SeasonCloseController {
  constructor(private readonly closing: SeasonCloseService) {}

  @Get(":id/close")
  preview(@Param("id", idPipe) id: number): Promise<SeasonClosePreview> {
    return this.closing.preview(id);
  }

  @HttpCode(200)
  @Post(":id/close")
  close(
    @CurrentUser() admin: ResolvedUser,
    @Param("id", idPipe) id: number,
    @Body(new ZodValidationPipe(seasonCloseBodySchema)) body: SeasonCloseBody,
  ): Promise<SeasonCloseResponse> {
    return this.closing.close(admin.id, id, body.confirmYear);
  }
}
