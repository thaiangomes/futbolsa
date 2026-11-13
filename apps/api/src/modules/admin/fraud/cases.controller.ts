import { Controller, Get, Query } from "@nestjs/common";
import { fraudCasesQuerySchema, type FraudCasesQuery, type FraudCasesResponse } from "@futbolsa/contracts";
import { AdminOnly } from "../../../infra/auth-adapter/index.js";
import { ZodValidationPipe } from "../../../infra/http/index.js";
import { FraudCasesService } from "./cases.service.js";

/** `GET /admin/fraud/cases`: os casos de trapaça da temporada atual (T21). Só admin. */
@AdminOnly()
@Controller("admin/fraud/cases")
export class FraudCasesController {
  constructor(private readonly cases: FraudCasesService) {}

  @Get()
  list(@Query(new ZodValidationPipe(fraudCasesQuerySchema)) query: FraudCasesQuery): Promise<FraudCasesResponse> {
    return this.cases.list(query);
  }
}
