import { Module } from "@nestjs/common";
import { RealtimeAuthenticator } from "./authenticator.js";
import { EventBus } from "./bus.js";
import { FakeRealtimeAuthenticator } from "./fake-authenticator.js";
import { RealtimeGateway } from "./gateway.js";
import { MemoryEventBus } from "./memory-bus.js";

/**
 * WebSocket e barramento de eventos (F6). Os módulos de negócio injetam o `EventBus` e só
 * publicam. O autenticador é o falso até a T12 ligar o login real da F5.
 */
@Module({
  providers: [
    { provide: EventBus, useClass: MemoryEventBus },
    { provide: RealtimeAuthenticator, useClass: FakeRealtimeAuthenticator },
    RealtimeGateway,
  ],
  exports: [EventBus, RealtimeGateway],
})
export class RealtimeModule {}
