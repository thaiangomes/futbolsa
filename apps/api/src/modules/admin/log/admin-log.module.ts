import { Module } from "@nestjs/common";
import { AdminLogService } from "./admin-log.service.js";

/** O registro do admin para os outros módulos (o `accounts` usa nos convites e papéis). */
@Module({ providers: [AdminLogService], exports: [AdminLogService] })
export class AdminLogModule {}
