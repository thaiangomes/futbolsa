import { Controller, Get, Query } from "@nestjs/common";
import { auditQuerySchema, type AuditQuery, type AuditResponse } from "@futbolsa/contracts";
import { AdminOnly } from "../../../infra/auth-adapter/index.js";
import { ZodValidationPipe } from "../../../infra/http/index.js";
import { AuditService } from "./audit.service.js";

/** `GET /admin/trades`: a auditoria de negócios, com comprador e vendedor (T7 da F14). Só admin. */
@AdminOnly()
@Controller("admin/trades")
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(@Query(new ZodValidationPipe(auditQuerySchema)) query: AuditQuery): Promise<AuditResponse> {
    return this.audit.list(query);
  }
}
