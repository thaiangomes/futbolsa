import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put } from "@nestjs/common";
import {
  type PutQualifiedBody,
  putQualifiedBodySchema,
  type PatchStandingsBody,
  patchStandingsBodySchema,
  type StandingsCompetition,
  type StandingsResponse,
  standingsCompetitionSchema,
  type StandingsView,
} from "@futbolsa/contracts";
import { AdminOnly, CurrentUser, type ResolvedUser } from "../../../infra/auth-adapter/index.js";
import { ZodValidationPipe } from "../../../infra/http/index.js";
import { StandingsService } from "./standings.service.js";

const competitionPipe = new ZodValidationPipe(standingsCompetitionSchema);

/** Classificação oficial: ver, corrigir a ordem com motivo e conferir (Dividendos e recompra, critério 8). */
@AdminOnly()
@Controller("admin/standings")
export class StandingsController {
  constructor(private readonly standings: StandingsService) {}

  @Get()
  async list(): Promise<StandingsResponse> {
    return { standings: await this.standings.list() };
  }

  @Patch(":competition")
  correct(
    @CurrentUser() admin: ResolvedUser,
    @Param("competition", competitionPipe) competition: StandingsCompetition,
    @Body(new ZodValidationPipe(patchStandingsBodySchema)) body: PatchStandingsBody,
  ): Promise<StandingsView> {
    return this.standings.correct(admin.id, competition, body);
  }

  /** Marca os classificados para a Libertadores e a Sul-Americana (só a Série A). */
  @Put("brasileirao-a/qualified")
  setQualified(
    @CurrentUser() admin: ResolvedUser,
    @Body(new ZodValidationPipe(putQualifiedBodySchema)) body: PutQualifiedBody,
  ): Promise<StandingsView> {
    return this.standings.setQualified(admin.id, body);
  }

  @HttpCode(200)
  @Post(":competition/confirm")
  confirm(
    @CurrentUser() admin: ResolvedUser,
    @Param("competition", competitionPipe) competition: StandingsCompetition,
  ): Promise<StandingsView> {
    return this.standings.confirm(admin.id, competition);
  }
}
