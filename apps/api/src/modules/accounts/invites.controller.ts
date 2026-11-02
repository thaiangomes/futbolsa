import { Body, Controller, Delete, Get, HttpCode, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { type InvitesBody, invitesBodySchema } from "@futbolsa/contracts";
import { AdminOnly, CurrentUser, type ResolvedUser } from "../../infra/auth-adapter/index.js";
import { ZodValidationPipe } from "../../infra/http/index.js";
import { InvitesService } from "./invites.service.js";

/** Lista de e-mails liberados: só admin (Admin, critério 31). O admin vê os e-mails; ninguém mais. */
@AdminOnly()
@Controller("admin/invites")
export class InvitesController {
  constructor(private readonly invites: InvitesService) {}

  @Get()
  async list() {
    return { invites: await this.invites.list() };
  }

  @Post()
  create(@CurrentUser() admin: ResolvedUser, @Body(new ZodValidationPipe(invitesBodySchema)) body: InvitesBody) {
    return this.invites.create(admin.id, body.emails);
  }

  @HttpCode(204)
  @Delete(":email")
  async revoke(
    @CurrentUser() admin: ResolvedUser,
    @Param("email", new ZodValidationPipe(z.email().max(254))) email: string,
  ): Promise<void> {
    await this.invites.revoke(admin.id, email);
  }
}
