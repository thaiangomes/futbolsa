import { Body, Controller, Get, HttpCode, Patch, Post } from "@nestjs/common";
import {
  createMeBodySchema,
  type CreateMeBody,
  type MeResponse,
  patchNicknameBodySchema,
  type PatchNicknameBody,
} from "@futbolsa/contracts";
import {
  AllowUnregistered,
  CurrentAuth,
  CurrentUser,
  type RequestAuth,
  type ResolvedUser,
} from "../../infra/auth-adapter/index.js";
import { RateLimit, ZodValidationPipe } from "../../infra/http/index.js";
import { AccountsService } from "./accounts.service.js";
import { accountError } from "./errors.js";

/** A conta de quem chama: só os próprios dados, nunca os de outra pessoa. */
@Controller("me")
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @AllowUnregistered()
  @Get()
  me(@CurrentAuth() auth: RequestAuth): Promise<MeResponse> {
    return this.accounts.me(auth.identity, auth.user);
  }

  @AllowUnregistered()
  @RateLimit("signup")
  @Post()
  async register(
    @CurrentAuth() auth: RequestAuth,
    @Body(new ZodValidationPipe(createMeBodySchema)) body: CreateMeBody,
  ): Promise<MeResponse> {
    if (auth.user) throw accountError("already_registered");
    const user = await this.accounts.register(auth.identity, body.nickname);
    return this.accounts.me(auth.identity, user);
  }

  @RateLimit("signup")
  @HttpCode(204)
  @Patch("nickname")
  async changeNickname(
    @CurrentUser() user: ResolvedUser,
    @Body(new ZodValidationPipe(patchNicknameBodySchema)) body: PatchNicknameBody,
  ): Promise<void> {
    await this.accounts.changeNickname(user.id, body.nickname);
  }
}
