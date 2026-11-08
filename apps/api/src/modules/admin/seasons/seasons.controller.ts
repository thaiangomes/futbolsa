import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put } from "@nestjs/common";
import { z } from "zod";
import {
  type CurrentSeasonResponse,
  createSeasonBodySchema,
  type PatchSeasonBody,
  patchSeasonBodySchema,
  type PublicSeason,
  type PutSeasonClubsBody,
  putSeasonClubsBodySchema,
  type SeasonView,
} from "@futbolsa/contracts";
import { AdminOnly, CurrentUser, Public, type ResolvedUser } from "../../../infra/auth-adapter/index.js";
import { ZodValidationPipe } from "../../../infra/http/index.js";
import { SeasonsService } from "./seasons.service.js";

const idPipe = new ZodValidationPipe(z.coerce.number().int().positive());

/** `GET /season`: a temporada atual e os clubes suspensos com o motivo, para todos (Admin, critério 23). */
@Controller("season")
export class PublicSeasonController {
  constructor(private readonly seasons: SeasonsService) {}

  @Public()
  @Get()
  current(): Promise<PublicSeason> {
    return this.seasons.publicView();
  }
}

/** Preparar a temporada: criar, oferta, primeiro jogo e lista de clubes (as regras e as copas ficam em `rules.controller.ts`). */
@AdminOnly()
@Controller("admin/seasons")
export class SeasonsController {
  constructor(private readonly seasons: SeasonsService) {}

  @Get("current")
  current(): Promise<CurrentSeasonResponse> {
    return this.seasons.current();
  }

  @HttpCode(201)
  @Post()
  create(
    @CurrentUser() admin: ResolvedUser,
    @Body(new ZodValidationPipe(createSeasonBodySchema)) body: { year: number },
  ): Promise<SeasonView> {
    return this.seasons.create(admin.id, body.year);
  }

  @Patch(":id")
  patch(
    @CurrentUser() admin: ResolvedUser,
    @Param("id", idPipe) id: number,
    @Body(new ZodValidationPipe(patchSeasonBodySchema)) body: PatchSeasonBody,
  ): Promise<SeasonView> {
    return this.seasons.patch(admin.id, id, body);
  }

  @Put(":id/clubs")
  async putClubs(
    @CurrentUser() admin: ResolvedUser,
    @Param("id", idPipe) id: number,
    @Body(new ZodValidationPipe(putSeasonClubsBodySchema)) body: PutSeasonClubsBody,
  ): Promise<{ clubs: CurrentSeasonResponse["clubs"] }> {
    return { clubs: await this.seasons.putClubs(admin.id, id, body) };
  }
}
