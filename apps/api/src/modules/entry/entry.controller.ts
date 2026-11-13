import { Body, Controller, Get, Post, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { enterBodySchema, type EnterBody, type EnterResult, type EntryPreview } from "@futbolsa/contracts";
import { CurrentUser, type ResolvedUser } from "../../infra/auth-adapter/index.js";
import { RateLimit, ZodValidationPipe } from "../../infra/http/index.js";
import { EntryService } from "./enter.service.js";
import { EntryPreviewService } from "./preview.service.js";

/**
 * As rotas da entrada no meio da temporada. Login padrão do jogo; quem decide é o serviço (a conta bloqueada, a janela, o
 * mercado suspenso). O módulo `entry` não importa o `accounts` (P7): o guard entrega o usuário com a situação da conta e o
 * serviço recebe só o que precisa.
 */
@Controller("entry")
export class EntryController {
  constructor(
    private readonly previews: EntryPreviewService,
    private readonly entries: EntryService,
  ) {}

  /** A prévia não trava nada e vale o preço do momento da leitura (P8). */
  @RateLimit("entryPreview")
  @Get("preview")
  preview(@CurrentUser() user: ResolvedUser): Promise<EntryPreview> {
    return this.previews.preview({ type: "user", userId: user.id, status: user.status });
  }

  /** 201 com a carteira nova; 200 com o mesmo resultado para quem repete (`repeated: true`). */
  @RateLimit("entry")
  @Post()
  async enter(
    @CurrentUser() user: ResolvedUser,
    @Body(new ZodValidationPipe(enterBodySchema)) body: EnterBody,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<EnterResult> {
    const outcome = await this.entries.enter({ type: "user", userId: user.id, status: user.status }, body.mode);
    void reply.status(outcome.created ? 201 : 200);
    return outcome.result;
  }
}
