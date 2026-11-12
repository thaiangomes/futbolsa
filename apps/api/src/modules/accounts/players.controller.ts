import { Controller, Get, Param } from "@nestjs/common";
import { COMMON_ERROR_MESSAGES, nicknameSchema, type PublicPlayer } from "@futbolsa/contracts";
import { Public } from "../../infra/auth-adapter/index.js";
import { DomainError, ZodValidationPipe } from "../../infra/http/index.js";
import { SnapshotService } from "../portfolio/snapshots/snapshot.service.js";
import { AccountsService } from "./accounts.service.js";

/** Perfil público de um jogador: o apelido e a foto mensal da carteira, em % (a F10). */
@Controller("players")
export class PlayersController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly snapshots: SnapshotService,
  ) {}

  @Public()
  @Get(":nickname")
  async profile(@Param("nickname", new ZodValidationPipe(nicknameSchema)) nickname: string): Promise<PublicPlayer> {
    const player = await this.accounts.publicPlayer(nickname);
    if (!player) throw new DomainError("not_found", 404, COMMON_ERROR_MESSAGES.not_found);
    return { nickname: player.nickname, snapshot: await this.snapshots.latestForNickname(player.nickname) };
  }
}
