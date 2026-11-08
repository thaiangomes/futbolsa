import { Module } from "@nestjs/common";
import { AdminLogService } from "./admin-log.service.js";
import { AdminLogController } from "./log.controller.js";

/** O registro do admin para os outros módulos (o `accounts` usa nos convites e papéis) e a rota `GET /admin/log`. */
@Module({ controllers: [AdminLogController], providers: [AdminLogService], exports: [AdminLogService] })
export class AdminLogModule {}
