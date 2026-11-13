import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from "@nestjs/common";
import {
  createFraudCaseBodySchema,
  fraudCaseQuerySchema,
  fraudCasesQuerySchema,
  type CreateFraudCaseBody,
  type FraudCaseDetail,
  type FraudCaseQuery,
  type FraudCasesQuery,
  type FraudCasesResponse,
} from "@futbolsa/contracts";
import { AdminOnly, CurrentUser, type ResolvedUser } from "../../../infra/auth-adapter/index.js";
import { ZodValidationPipe } from "../../../infra/http/index.js";
import { FraudCasesService } from "./cases.service.js";
import { FraudReportService } from "./report.service.js";

/** Os casos de trapaça da temporada atual e o relatório de cada um (T21 e T22). Só admin. */
@AdminOnly()
@Controller("admin/fraud/cases")
export class FraudCasesController {
  constructor(
    private readonly cases: FraudCasesService,
    private readonly reports: FraudReportService,
  ) {}

  @Get()
  list(@Query(new ZodValidationPipe(fraudCasesQuerySchema)) query: FraudCasesQuery): Promise<FraudCasesResponse> {
    return this.cases.list(query);
  }

  /** O relatório manual de um par, a partir da auditoria: abre um caso sem alerta. */
  @Post()
  open(@CurrentUser() admin: ResolvedUser, @Body(new ZodValidationPipe(createFraudCaseBodySchema)) body: CreateFraudCaseBody): Promise<FraudCaseDetail> {
    return this.reports.open(admin.id, body);
  }

  @Get(":id")
  detail(@Param("id", ParseIntPipe) id: number, @Query(new ZodValidationPipe(fraudCaseQuerySchema)) query: FraudCaseQuery): Promise<FraudCaseDetail> {
    const without = query.without ? query.without.split(",").map(Number) : undefined;
    return this.reports.detail(id, without);
  }
}
