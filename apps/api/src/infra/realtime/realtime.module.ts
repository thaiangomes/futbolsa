import { Module } from "@nestjs/common";
import { RealtimeGateway } from "./gateway.js";

/** WebSocket e barramento de eventos (F6). */
@Module({
  providers: [RealtimeGateway],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
