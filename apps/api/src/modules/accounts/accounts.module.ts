import { Global, Module } from "@nestjs/common";
import { UserResolver } from "../../infra/auth-adapter/index.js";
import { PortfolioModule } from "../portfolio/index.js";
import { AccountsConfig, accountsConfigFromEnv } from "./accounts.config.js";
import { AccountsController } from "./accounts.controller.js";
import { AccountsService } from "./accounts.service.js";
import { IdentityService } from "./identity.service.js";
import { PlayersController } from "./players.controller.js";

/**
 * Conta e login. Global porque o guard de login (de todas as rotas) e o WebSocket perguntam a
 * ele quem é o usuário de uma identidade, pela porta `UserResolver`, e porque a F8 chama o
 * `AccountsService.creditSeasonStart` na abertura do IPO.
 */
@Global()
@Module({
  imports: [PortfolioModule],
  controllers: [AccountsController, PlayersController],
  providers: [
    IdentityService,
    { provide: UserResolver, useExisting: IdentityService },
    { provide: AccountsConfig, useFactory: () => accountsConfigFromEnv() },
    AccountsService,
  ],
  exports: [UserResolver, IdentityService, AccountsService],
})
export class AccountsModule {}
