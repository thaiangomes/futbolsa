import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
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
import { fraudReportHtml } from "./report-file.js";
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

  /** O relatório como arquivo HTML que abre sozinho e imprime em PDF (T23), feito da foto do caso. */
  @Get(":id/download")
  async download(@Param("id", ParseIntPipe) id: number, @Res({ passthrough: true }) reply: FastifyReply): Promise<string> {
    const detail = await this.reports.detail(id);
    void reply.header("content-type", "text/html; charset=utf-8");
    void reply.header("content-disposition", `attachment; filename="relatorio-trapaca-${id}.html"`);
    return fraudReportHtml(detail);
  }

  @Get(":id")
  detail(@Param("id", ParseIntPipe) id: number, @Query(new ZodValidationPipe(fraudCaseQuerySchema)) query: FraudCaseQuery): Promise<FraudCaseDetail> {
    const without = query.without ? query.without.split(",").map(Number) : undefined;
    return this.reports.detail(id, without);
  }
}
