import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { type RunImportBody, type RunImportResponse, runImportBodySchema } from "@futbolsa/contracts";
import { AdminOnly, CurrentUser, type ResolvedUser } from "../../../infra/auth-adapter/index.js";
import { ZodValidationPipe } from "../../../infra/http/index.js";
import { ImportRunner } from "./import-runner.js";

/** Importar na hora, para o admin não esperar 15 minutos depois de um erro da fonte. */
@AdminOnly()
@Controller("admin/imports")
export class ImportsController {
  constructor(private readonly runner: ImportRunner) {}

  @HttpCode(200)
  @Post("run")
  async run(
    @CurrentUser() admin: ResolvedUser,
    @Body(new ZodValidationPipe(runImportBodySchema)) body: RunImportBody,
  ): Promise<RunImportResponse> {
    return { reports: await this.runner.runNow(admin.id, body) };
  }
}
