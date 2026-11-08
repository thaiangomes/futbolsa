import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import { z } from "zod";
import {
  type AdminMatch,
  type CreateMatchBody,
  createMatchBodySchema,
  type ListMatchesQuery,
  listMatchesQuerySchema,
  type ListMatchesResponse,
  type PatchMatchBody,
  patchMatchBodySchema,
} from "@futbolsa/contracts";
import { AdminOnly, CurrentUser, type ResolvedUser } from "../../../infra/auth-adapter/index.js";
import { ZodValidationPipe } from "../../../infra/http/index.js";
import { MatchesService } from "./matches.service.js";

/** Jogos do admin: ver com a divergência da fonte, cadastrar e corrigir (Admin, critérios 5, 6, 8 e 33). */
@AdminOnly()
@Controller("admin/matches")
export class MatchesController {
  constructor(private readonly matches: MatchesService) {}

  @Get()
  async list(@Query(new ZodValidationPipe(listMatchesQuerySchema)) query: ListMatchesQuery): Promise<ListMatchesResponse> {
    return { matches: await this.matches.list(query) };
  }

  @HttpCode(201)
  @Post()
  create(
    @CurrentUser() admin: ResolvedUser,
    @Body(new ZodValidationPipe(createMatchBodySchema)) body: CreateMatchBody,
  ): Promise<AdminMatch> {
    return this.matches.create(admin.id, body);
  }

  @Patch(":id")
  patch(
    @CurrentUser() admin: ResolvedUser,
    @Param("id", new ZodValidationPipe(z.coerce.number().int().positive())) id: number,
    @Body(new ZodValidationPipe(patchMatchBodySchema)) body: PatchMatchBody,
  ): Promise<AdminMatch> {
    return this.matches.patch(admin.id, id, body);
  }
}
