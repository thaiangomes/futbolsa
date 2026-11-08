import { Controller, Get, Query } from "@nestjs/common";
import { type AdminLogQuery, type AdminLogResponse, adminLogQuerySchema } from "@futbolsa/contracts";
import { AdminOnly } from "../../../infra/auth-adapter/index.js";
import { ZodValidationPipe } from "../../../infra/http/index.js";
import { AdminLogService } from "./admin-log.service.js";

/** O registro do admin, para todos os admins verem (Admin, critérios 31 e 33). */
@AdminOnly()
@Controller("admin/log")
export class AdminLogController {
  constructor(private readonly log: AdminLogService) {}

  @Get()
  list(@Query(new ZodValidationPipe(adminLogQuerySchema)) query: AdminLogQuery): Promise<AdminLogResponse> {
    return this.log.listLog(query);
  }
}
