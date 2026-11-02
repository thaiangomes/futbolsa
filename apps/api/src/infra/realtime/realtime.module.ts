import { Module } from "@nestjs/common";
import { EventBus } from "./bus.js";
import { RealtimeGateway } from "./gateway.js";
import { MemoryEventBus } from "./memory-bus.js";

/** WebSocket e barramento de eventos (F6). Os módulos de negócio injetam o `EventBus` e só publicam. */
@Module({
  providers: [{ provide: EventBus, useClass: MemoryEventBus }, RealtimeGateway],
  exports: [EventBus, RealtimeGateway],
})
export class RealtimeModule {}
