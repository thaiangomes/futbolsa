import { Module } from "@nestjs/common";
import { AuditController } from "./audit.controller.js";
import { AuditService } from "./audit.service.js";

/** Auditoria de negócios do admin (F14, T7). */
@Module({ controllers: [AuditController], providers: [AuditService] })
export class AuditModule {}
