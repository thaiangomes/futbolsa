import { Module } from "@nestjs/common";
import { RealtimeAuthenticator } from "./authenticator.js";
import { AuthFromAccounts } from "./auth-from-accounts.js";
import { EventBus } from "./bus.js";
import { RealtimeGateway } from "./gateway.js";
import { MemoryEventBus } from "./memory-bus.js";

/**
 * WebSocket e barramento de eventos (F6). Os módulos de negócio injetam o `EventBus` e só
 * publicam. O login do WebSocket usa o `AuthVerifier` e o `UserResolver` da F5 (globais); os
 * testes de tempo real trocam o autenticador pelo `FakeRealtimeAuthenticator`.
 */
@Module({
  providers: [
    { provide: EventBus, useClass: MemoryEventBus },
    { provide: RealtimeAuthenticator, useClass: AuthFromAccounts },
    RealtimeGateway,
  ],
  exports: [EventBus, RealtimeGateway],
})
export class RealtimeModule {}
