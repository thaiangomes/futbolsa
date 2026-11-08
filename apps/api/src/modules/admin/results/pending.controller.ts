import { Controller, Get } from "@nestjs/common";
import type { PendingResponse } from "@futbolsa/contracts";
import { AdminOnly } from "../../../infra/auth-adapter/index.js";
import { PendingService } from "./pending.service.js";

/** Os jogos que já deviam ter terminado e seguem sem placar (Admin, critério 5). */
@AdminOnly()
@Controller("admin/pending")
export class PendingController {
  constructor(private readonly pending: PendingService) {}

  @Get()
  list(): Promise<PendingResponse> {
    return this.pending.compute();
  }
}
