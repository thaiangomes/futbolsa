import { Body, Controller, Get, HttpCode, Patch } from "@nestjs/common";
import { type BotsView, patchBotsBodySchema, type PatchBotsBody, type PatchBotsResponse } from "@futbolsa/contracts";
import { AdminOnly, CurrentUser, type ResolvedUser } from "../../../infra/auth-adapter/index.js";
import { ZodValidationPipe } from "../../../infra/http/index.js";
import { BotsService } from "./bots.service.js";

/** Bots ao vivo (T10 da F14): quantos ativos por perfil. Só admin. */
@AdminOnly()
@Controller("admin/bots")
export class BotsController {
  constructor(private readonly bots: BotsService) {}

  @Get()
  view(): Promise<BotsView> {
    return this.bots.view();
  }

  @HttpCode(200)
  @Patch()
  update(@CurrentUser() admin: ResolvedUser, @Body(new ZodValidationPipe(patchBotsBodySchema)) body: PatchBotsBody): Promise<PatchBotsResponse> {
    return this.bots.update(admin.id, body);
  }
}
