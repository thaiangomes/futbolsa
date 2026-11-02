import { Global, Module } from "@nestjs/common";
import { UserResolver } from "../../infra/auth-adapter/index.js";
import { IdentityService } from "./identity.service.js";

/**
 * Conta e login. Global porque o guard de login (de todas as rotas) e o WebSocket perguntam a
 * ele quem é o usuário de uma identidade, pela porta `UserResolver`.
 */
@Global()
@Module({
  providers: [IdentityService, { provide: UserResolver, useExisting: IdentityService }],
  exports: [UserResolver, IdentityService],
})
export class AccountsModule {}
