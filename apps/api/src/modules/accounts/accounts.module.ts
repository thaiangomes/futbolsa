import { Global, Module } from "@nestjs/common";
import { UserResolver } from "../../infra/auth-adapter/index.js";
import { AdminLogModule } from "../admin/log/index.js";
import { PortfolioModule } from "../portfolio/index.js";
import { AccountsConfig, accountsConfigFromEnv } from "./accounts.config.js";
import { AccountsController } from "./accounts.controller.js";
import { AccountsService } from "./accounts.service.js";
import { AccountClosureHooks } from "./closure-hooks.js";
import { AccountDeletionService } from "./deletion.service.js";
import { IdentityService } from "./identity.service.js";
import { InvitesController } from "./invites.controller.js";
import { InvitesService } from "./invites.service.js";
import { PlayersController } from "./players.controller.js";
import { RolesController } from "./roles.controller.js";
import { RolesService } from "./roles.service.js";

/**
 * Conta e login. Global porque o guard de login (de todas as rotas) e o WebSocket perguntam a
 * ele quem é o usuário de uma identidade, pela porta `UserResolver`; porque a F8 chama o
 * `AccountsService.creditSeasonStart` na abertura do IPO; e porque a F8 e a F9 registram os
 * ganchos de encerramento (`AccountClosureHooks`), que a F14 usa no bloqueio e na exclusão.
 */
@Global()
@Module({
  imports: [PortfolioModule, AdminLogModule],
  controllers: [AccountsController, PlayersController, InvitesController, RolesController],
  providers: [
    IdentityService,
    { provide: UserResolver, useExisting: IdentityService },
    { provide: AccountsConfig, useFactory: () => accountsConfigFromEnv() },
    AccountsService,
    AccountClosureHooks,
    AccountDeletionService,
    InvitesService,
    RolesService,
  ],
  exports: [UserResolver, IdentityService, AccountsService, AccountClosureHooks, AccountDeletionService],
})
export class AccountsModule {}
