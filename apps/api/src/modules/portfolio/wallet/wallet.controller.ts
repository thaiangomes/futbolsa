import { Controller, Get } from "@nestjs/common";
import type { WalletView } from "@futbolsa/contracts";
import { CurrentUser, type ResolvedUser } from "../../../infra/auth-adapter/index.js";
import { WalletService } from "./wallet.service.js";

/** `GET /portfolio`: a carteira do jogador logado. A conta bloqueada também lê a própria carteira. */
@Controller("portfolio")
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get()
  view(@CurrentUser() user: ResolvedUser): Promise<WalletView> {
    return this.wallet.viewForUser(user.id);
  }
}
