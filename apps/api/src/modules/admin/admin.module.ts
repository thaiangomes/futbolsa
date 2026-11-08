import { Module } from "@nestjs/common";
import { AdminLogModule } from "./log/index.js";
import { ResultsModule } from "./results/results.module.js";
import { SeasonsModule } from "./seasons/seasons.module.js";
import { StandingsModule } from "./standings/standings.module.js";
import { SuspensionModule } from "./suspension/suspension.module.js";

/**
 * Admin (resultados, temporada, suspensão e registro; pagamentos e jogadores chegam nas F12 e F14).
 * Cada subpasta tem o próprio módulo, já registrado aqui, para as pistas da F7 não brigarem no mesmo arquivo.
 */
@Module({
  imports: [AdminLogModule, ResultsModule, StandingsModule, SeasonsModule, SuspensionModule],
})
export class AdminModule {}
