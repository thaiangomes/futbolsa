import { Global, Module } from "@nestjs/common";
import { Clock, SystemClock } from "./clock.js";

/** Global: qualquer módulo injeta `Clock` sem importar este. */
@Global()
@Module({
  providers: [{ provide: Clock, useClass: SystemClock }],
  exports: [Clock],
})
export class ClockModule {}
