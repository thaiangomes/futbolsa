import { Module } from "@nestjs/common";
import { RealtimeModule } from "../../infra/realtime/index.js";
import { PortfolioModule } from "../portfolio/index.js";
import { EntryGate } from "./entry-gate.js";
import { EntryEvents } from "./events.js";
import { EntryService } from "./enter.service.js";
import { EntryPreviewService } from "./preview.service.js";

/**
 * Entrada no meio da temporada (F11): a prévia sem trava, a transação de entrada com emissão de ações e a janela pelos
 * jogos da Série A. O `accounts` pergunta a janela por `readAvailability` (o `entry` não importa o `accounts`, P7).
 */
@Module({
  imports: [PortfolioModule, RealtimeModule],
  providers: [EntryGate, EntryEvents, EntryService, EntryPreviewService],
  exports: [EntryService, EntryPreviewService],
})
export class EntryModule {}
