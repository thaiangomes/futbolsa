import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import {
  ADMIN_ERROR_MESSAGES,
  type ApprovePayoutsBody,
  approvePayoutsBodySchema,
  type ApprovePayoutsResponse,
  COMMON_ERROR_MESSAGES,
  type PayoutHoldersQuery,
  payoutHoldersQuerySchema,
  type PayoutHoldersResponse,
  type PayoutListQuery,
  payoutListQuerySchema,
  type PayoutListResponse,
} from "@futbolsa/contracts";
import { AdminOnly, CurrentUser, type ResolvedUser } from "../../../infra/auth-adapter/index.js";
import { DomainError, ZodValidationPipe } from "../../../infra/http/index.js";
import { ApproveService } from "./approve.service.js";
import { PreviewService } from "./preview.service.js";
import { SettleCreditsService } from "./settle-credits.js";

const idPipe = new ZodValidationPipe(z.coerce.number().int().positive());

/**
 * Pagamentos do admin: a prévia (Admin, critérios 2 e 31) e a aprovação (T5). A correção tem o controlador dela
 * (`corrections.controller.ts`), na mesma rota-base.
 */
@AdminOnly()
@Controller("admin/payouts")
export class PayoutsController {
  constructor(
    private readonly preview: PreviewService,
    private readonly approval: ApproveService,
    private readonly settle: SettleCreditsService,
  ) {}

  /**
   * Aprova uma lista de eventos ou todos os pendentes (Admin, critérios 3, 4 e 33). A resposta sai depois da etapa
   * 1 (os eventos já `approved`); o crédito segue em lotes, em segundo plano, e a prévia mostra "liquidando" até
   * acabar. Pedido de um evento só que não pôde ser aprovado vira erro (409 `event_superseded` ou
   * `standings_not_confirmed`, 404 `not_found`), para a tela tratar como a ação que falhou; numa lista maior ou em
   * "todos", a resposta é 200 com o resultado de cada um.
   */
  @HttpCode(200)
  @Post("approve")
  async approve(
    @CurrentUser() admin: ResolvedUser,
    @Body(new ZodValidationPipe(approvePayoutsBodySchema)) body: ApprovePayoutsBody,
  ): Promise<ApprovePayoutsResponse> {
    let response: ApprovePayoutsResponse;
    try {
      response = await this.approval.approve(admin.id, body);
    } finally {
      // o que já foi aprovado sai em lotes, mesmo se um evento do meio falhou (a tarefa de cada minuto também pega)
      this.settle.trigger();
    }
    if ("eventIds" in body && body.eventIds.length === 1) {
      const outcome = response.results[0]?.outcome;
      if (outcome === "event_superseded" || outcome === "standings_not_confirmed") {
        throw new DomainError(outcome, 409, ADMIN_ERROR_MESSAGES[outcome]);
      }
      if (outcome === "not_found") throw new DomainError("not_found", 404, COMMON_ERROR_MESSAGES.not_found);
    }
    return response;
  }

  @Get()
  list(@Query(new ZodValidationPipe(payoutListQuerySchema)) query: PayoutListQuery): Promise<PayoutListResponse> {
    return this.preview.list(query);
  }

  @Get(":id/holders")
  holders(
    @Param("id", idPipe) id: number,
    @Query(new ZodValidationPipe(payoutHoldersQuerySchema)) query: PayoutHoldersQuery,
  ): Promise<PayoutHoldersResponse> {
    return this.preview.holders(id, query);
  }
}
