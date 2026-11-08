import { Body, Controller, Get, HttpCode, Param, Post, Put } from "@nestjs/common";
import { z } from "zod";
import {
  type CupCompetitionCode,
  cupCompetitionSchema,
  type CupView,
  type PutCupBody,
  putCupBodySchema,
  type PutSeasonRulesBody,
  putSeasonRulesBodySchema,
  type SeasonRulesResponse,
  type SeasonRulesView,
} from "@futbolsa/contracts";
import { AdminOnly, CurrentUser, type ResolvedUser } from "../../../infra/auth-adapter/index.js";
import { ZodValidationPipe } from "../../../infra/http/index.js";
import { RulesService } from "./rules.service.js";

const idPipe = new ZodValidationPipe(z.coerce.number().int().positive());
const cupPipe = new ZodValidationPipe(cupCompetitionSchema);

/** Valores das ligas e tabela de cada copa, com os avisos de `validateCupTable` (Dividendos e recompra, critério 28). */
@AdminOnly()
@Controller("admin/seasons/:id")
export class RulesController {
  constructor(private readonly rules: RulesService) {}

  @Get("rules")
  get(@Param("id", idPipe) id: number): Promise<SeasonRulesResponse> {
    return this.rules.get(id);
  }

  @Put("rules")
  putRules(
    @CurrentUser() admin: ResolvedUser,
    @Param("id", idPipe) id: number,
    @Body(new ZodValidationPipe(putSeasonRulesBodySchema)) body: PutSeasonRulesBody,
  ): Promise<SeasonRulesView> {
    return this.rules.putRules(admin.id, id, body);
  }

  @Put("cups/:competition")
  putCup(
    @CurrentUser() admin: ResolvedUser,
    @Param("id", idPipe) id: number,
    @Param("competition", cupPipe) competition: CupCompetitionCode,
    @Body(new ZodValidationPipe(putCupBodySchema)) body: PutCupBody,
  ): Promise<CupView> {
    return this.rules.putCup(admin.id, id, competition, body);
  }

  @HttpCode(200)
  @Post("cups/:competition/confirm")
  confirm(
    @CurrentUser() admin: ResolvedUser,
    @Param("id", idPipe) id: number,
    @Param("competition", cupPipe) competition: CupCompetitionCode,
  ): Promise<CupView> {
    return this.rules.confirmCup(admin.id, id, competition);
  }
}
