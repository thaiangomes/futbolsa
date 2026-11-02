import { Controller, Get, Param } from "@nestjs/common";
import { COMMON_ERROR_MESSAGES, nicknameSchema, type PublicPlayer } from "@futbolsa/contracts";
import { Public } from "../../infra/auth-adapter/index.js";
import { DomainError, ZodValidationPipe } from "../../infra/http/index.js";
import { AccountsService } from "./accounts.service.js";

/** Perfil público de um jogador: só o apelido (a F10 acrescenta a foto mensal da carteira, em %). */
@Controller("players")
export class PlayersController {
  constructor(private readonly accounts: AccountsService) {}

  @Public()
  @Get(":nickname")
  async profile(@Param("nickname", new ZodValidationPipe(nicknameSchema)) nickname: string): Promise<PublicPlayer> {
    const player = await this.accounts.publicPlayer(nickname);
    if (!player) throw new DomainError("not_found", 404, COMMON_ERROR_MESSAGES.not_found);
    return player;
  }
}
