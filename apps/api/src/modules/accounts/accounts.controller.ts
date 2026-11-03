import { Body, Controller, Delete, Get, HttpCode, Patch, Post } from "@nestjs/common";
import {
  createMeBodySchema,
  type CreateMeBody,
  deleteMeBodySchema,
  type DeleteMeBody,
  type DeleteMeResponse,
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
import { Clock } from "../../infra/clock/index.js";
import { DomainError, RateLimit, ZodValidationPipe } from "../../infra/http/index.js";
import { AccountsService } from "./accounts.service.js";
import { AccountDeletionService, REAUTH_WINDOW_MS } from "./deletion.service.js";
import { accountError } from "./errors.js";

/** A conta de quem chama: só os próprios dados, nunca os de outra pessoa. */
@Controller("me")
export class AccountsController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly deletion: AccountDeletionService,
    private readonly clock: Clock,
  ) {}

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

  /**
   * Exclusão da conta, a qualquer momento (LGPD). Confirma digitando o apelido e pede um login
   * feito há no máximo 15 minutos: não limita quando excluir, só confere que é o dono (decisão do
   * Thaian em 2026-10-31). O bloqueado também pode.
   */
  @HttpCode(202)
  @Delete()
  async deleteMe(
    @CurrentAuth() auth: RequestAuth,
    @Body(new ZodValidationPipe(deleteMeBodySchema)) body: DeleteMeBody,
  ): Promise<DeleteMeResponse> {
    if (auth.identity.authenticatedAt.getTime() < this.clock.now().getTime() - REAUTH_WINDOW_MS) {
      throw accountError("reauth_required");
    }
    const me = await this.accounts.me(auth.identity, auth.user);
    if (!me.registered || me.nickname.toLowerCase() !== body.confirmNickname.toLowerCase()) {
      throw new DomainError("invalid_input", 400, "Digite o seu apelido para confirmar a exclusão.", ["confirmNickname"]);
    }
    return this.deletion.deleteAccount(auth.user!.id);
  }
}
