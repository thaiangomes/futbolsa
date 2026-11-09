import { Controller, Get } from "@nestjs/common";
import type { IpoOverview, IpoResults } from "@futbolsa/contracts";
import { CurrentUser, type ResolvedUser } from "../../infra/auth-adapter/index.js";
import { IpoReadService } from "./read.service.js";

/**
 * A leitura do IPO do jogador. Login padrão do jogo; as ofertas (`PUT` e `DELETE /ipo/bids/:ticker`)
 * ficam em `bids.controller.ts`.
 */
@Controller("ipo")
export class IpoController {
  constructor(private readonly read: IpoReadService) {}

  @Get()
  overview(@CurrentUser() user: ResolvedUser): Promise<IpoOverview> {
    return this.read.overview(user.id);
  }

  @Get("results")
  results(@CurrentUser() user: ResolvedUser): Promise<IpoResults> {
    return this.read.results(user.id);
  }
}
