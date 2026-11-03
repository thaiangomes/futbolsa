import { Body, Controller, HttpCode, Param, Patch } from "@nestjs/common";
import { z } from "zod";
import { type PatchRoleBody, patchRoleBodySchema } from "@futbolsa/contracts";
import { AdminOnly, CurrentUser, type ResolvedUser } from "../../infra/auth-adapter/index.js";
import { ZodValidationPipe } from "../../infra/http/index.js";
import { RolesService } from "./roles.service.js";

/** Papel de admin de um jogador: só admin, com motivo (Admin, critérios 31 a 33). */
@AdminOnly()
@Controller("admin/players")
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @HttpCode(204)
  @Patch(":id/role")
  async setRole(
    @CurrentUser() admin: ResolvedUser,
    @Param("id", new ZodValidationPipe(z.uuid())) id: string,
    @Body(new ZodValidationPipe(patchRoleBodySchema)) body: PatchRoleBody,
  ): Promise<void> {
    await this.roles.setRole(admin.id, id, body.role, body.reason);
  }
}
