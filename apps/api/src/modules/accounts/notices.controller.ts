import { Controller, HttpCode, Param, ParseIntPipe, Post } from "@nestjs/common";
import type { ReadNoticeResponse } from "@futbolsa/contracts";
import { CurrentUser, type ResolvedUser } from "../../infra/auth-adapter/index.js";
import { NoticesService } from "./notices.service.js";

/** `POST /me/notices/:id/read`: o jogador confirma que leu o aviso. Só o dono; o bloqueado também (T26 da F14). */
@Controller("me/notices")
export class NoticesController {
  constructor(private readonly notices: NoticesService) {}

  @HttpCode(200)
  @Post(":id/read")
  read(@CurrentUser() user: ResolvedUser, @Param("id", ParseIntPipe) id: number): Promise<ReadNoticeResponse> {
    return this.notices.markRead(user.id, id);
  }
}
