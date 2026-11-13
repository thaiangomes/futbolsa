import type { EnterOptions, EnterOutcome } from "./enter.service.js";

/** O que o `EntryService` oferece ao `admin` (F14) para ligar um bot depois do IPO. */
export interface BotEntry {
  /** Entrada do bot: sempre a carteira índice, mesma regra e mesma janela da pessoa, e repetível (devolve a mesma carteira). */
  enterBot(botId: number, options?: EnterOptions): Promise<EnterOutcome>;
}
