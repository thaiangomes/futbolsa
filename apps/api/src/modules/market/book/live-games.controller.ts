import { Controller, Get } from "@nestjs/common";
import type { LiveGames } from "@futbolsa/contracts";
import { Public } from "../../../infra/auth-adapter/index.js";
import { LiveGamesService } from "./live-games.service.js";

/** `GET /live-games` (item 25 da fila da partida de teste): os jogos ao vivo, os de mais tarde, os encerrados hoje e o próximo. Pública. */
@Controller("live-games")
export class LiveGamesController {
  constructor(private readonly games: LiveGamesService) {}

  @Public()
  @Get()
  read(): Promise<LiveGames> {
    return this.games.read();
  }
}
