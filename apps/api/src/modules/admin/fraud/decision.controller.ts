import { Body, Controller, Headers, HttpCode, Param, ParseIntPipe, Post } from "@nestjs/common";
import {
  ADMIN_ERROR_MESSAGES,
  confirmFraudBodySchema,
  dismissFraudBodySchema,
  type ConfirmFraudBody,
  type ConfirmFraudResponse,
  type DismissFraudBody,
  type DismissFraudResponse,
} from "@futbolsa/contracts";
import { AdminOnly, CurrentUser, type ResolvedUser } from "../../../infra/auth-adapter/index.js";
import { DomainError, ZodValidationPipe } from "../../../infra/http/index.js";
import { idempotencyKeySchema } from "../../market/orders/idempotency.js";
import { FraudDecisionService } from "./decision.service.js";

/** Decidir um caso de trapaça (T25): confirmar, que anula os negócios marcados, ou descartar. Só admin. */
@AdminOnly()
@Controller("admin/fraud/cases")
export class FraudDecisionController {
  constructor(private readonly decisions: FraudDecisionService) {}

  /** Com `Idempotency-Key`: a mesma chave devolve a mesma resposta e não anula duas vezes. */
  @HttpCode(200)
  @Post(":id/confirm")
  confirm(
    @CurrentUser() admin: ResolvedUser,
    @Param("id", ParseIntPipe) id: number,
    @Headers("idempotency-key") idempotencyKey: unknown,
    @Body(new ZodValidationPipe(confirmFraudBodySchema)) body: ConfirmFraudBody,
  ): Promise<ConfirmFraudResponse> {
    const key = idempotencyKeySchema.safeParse(idempotencyKey);
    if (!key.success) throw new DomainError("idempotency_key_required", 400, ADMIN_ERROR_MESSAGES.idempotency_key_required);
    return this.decisions.confirm(admin.id, id, body, key.data);
  }

  @HttpCode(200)
  @Post(":id/dismiss")
  dismiss(
    @CurrentUser() admin: ResolvedUser,
    @Param("id", ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(dismissFraudBodySchema)) body: DismissFraudBody,
  ): Promise<DismissFraudResponse> {
    return this.decisions.dismiss(admin.id, id, body);
  }
}
