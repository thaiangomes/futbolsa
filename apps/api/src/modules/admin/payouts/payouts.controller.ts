import { Controller, Get, Param, Query } from "@nestjs/common";
import { z } from "zod";
import {
  type PayoutHoldersQuery,
  payoutHoldersQuerySchema,
  type PayoutHoldersResponse,
  type PayoutListQuery,
  payoutListQuerySchema,
  type PayoutListResponse,
} from "@futbolsa/contracts";
import { AdminOnly } from "../../../infra/auth-adapter/index.js";
import { ZodValidationPipe } from "../../../infra/http/index.js";
import { PreviewService } from "./preview.service.js";

const idPipe = new ZodValidationPipe(z.coerce.number().int().positive());

/**
 * Pagamentos do admin: a prévia (Admin, critérios 2 e 31) e, na T5, a aprovação. A correção tem o controlador dela
 * (`corrections.controller.ts`), na mesma rota-base.
 */
@AdminOnly()
@Controller("admin/payouts")
export class PayoutsController {
  constructor(private readonly preview: PreviewService) {}

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
