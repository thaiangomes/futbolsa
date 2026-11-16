import { Body, Controller, Get, Param, Put } from "@nestjs/common";
import { clubTickerParamSchema, type Projection, type ProjectionBody, type ProjectionList, projectionBodySchema } from "@futbolsa/contracts";
import { CurrentUser, type ResolvedUser } from "../../../infra/auth-adapter/index.js";
import { ZodValidationPipe } from "../../../infra/http/index.js";
import { ProjectionsService } from "./projections.service.js";

/** `GET /me/projections` e `PUT /me/projections/:ticker`: as projeções privadas do jogador (critérios 54 a 56). Login padrão. */
@Controller("me/projections")
export class ProjectionsController {
  constructor(private readonly projections: ProjectionsService) {}

  @Get()
  list(@CurrentUser() user: ResolvedUser): Promise<ProjectionList> {
    return this.projections.list(user.id);
  }

  @Put(":ticker")
  save(
    @CurrentUser() user: ResolvedUser,
    @Param("ticker", new ZodValidationPipe(clubTickerParamSchema)) ticker: string,
    @Body(new ZodValidationPipe(projectionBodySchema)) body: ProjectionBody,
  ): Promise<Projection> {
    return this.projections.save(user.id, ticker, body);
  }
}
