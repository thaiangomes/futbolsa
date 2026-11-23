import { Body, Controller, Get, HttpCode, Param, Post, Put } from "@nestjs/common";
import { z } from "zod";
import { type PutSlotsBody, putSlotsBodySchema, type SlotRulesResponse } from "@futbolsa/contracts";
import { AdminOnly, CurrentUser, type ResolvedUser } from "../../../infra/auth-adapter/index.js";
import { ZodValidationPipe } from "../../../infra/http/index.js";
import { SlotsService } from "./slots.service.js";

const idPipe = new ZodValidationPipe(z.coerce.number().int().positive());

/** Regras de vaga para a Libertadores e a Sul-Americana do ano seguinte (Vagas e copas no valor justo dos bots). */
@AdminOnly()
@Controller("admin/seasons/:id/slots")
export class SlotsController {
  constructor(private readonly slots: SlotsService) {}

  @Get()
  get(@Param("id", idPipe) id: number): Promise<SlotRulesResponse> {
    return this.slots.get(id);
  }

  @Put()
  put(
    @CurrentUser() admin: ResolvedUser,
    @Param("id", idPipe) id: number,
    @Body(new ZodValidationPipe(putSlotsBodySchema)) body: PutSlotsBody,
  ): Promise<SlotRulesResponse> {
    return this.slots.put(admin.id, id, body);
  }

  /** A correção depois da abertura do IPO, com motivo no registro do admin. */
  @HttpCode(200)
  @Post("correction")
  correct(
    @CurrentUser() admin: ResolvedUser,
    @Param("id", idPipe) id: number,
    @Body(new ZodValidationPipe(putSlotsBodySchema)) body: PutSlotsBody,
  ): Promise<SlotRulesResponse> {
    return this.slots.correct(admin.id, id, body);
  }
}
