import { Controller, Get } from "@nestjs/common";
import type { HistoryResponse } from "@futbolsa/contracts";
import { CurrentUser, type ResolvedUser } from "../../infra/auth-adapter/index.js";
import { HistoryService } from "./history.service.js";

/** `GET /me/history`: as temporadas encerradas do jogador. A conta bloqueada também lê o próprio histórico. */
@Controller("me/history")
export class HistoryController {
  constructor(private readonly history: HistoryService) {}

  @Get()
  get(@CurrentUser() user: ResolvedUser): Promise<HistoryResponse> {
    return this.history.forUser(user.id);
  }
}
