import { Injectable } from "@nestjs/common";
import type { StandingsCompetition } from "@futbolsa/contracts";

/**
 * A ordem da classificação oficial mudou (importação que trocou a tabela ou correção do admin). Emitido depois
 * do `COMMIT`; a F12 assina para fechar a colocação e o acesso. A conferência não emite: ela não muda valor.
 */
export interface StandingsChangedEvent {
  seasonId: number;
  competition: StandingsCompetition;
}

export type StandingsChangedHandler = (event: StandingsChangedEvent) => void | Promise<void>;

/** Quem quiser saber que a classificação mudou se inscreve aqui. O erro de um assinante não afeta os outros. */
@Injectable()
export class StandingsEvents {
  private readonly handlers: StandingsChangedHandler[] = [];

  subscribe(handler: StandingsChangedHandler): void {
    this.handlers.push(handler);
  }

  async publish(event: StandingsChangedEvent): Promise<void> {
    for (const handler of this.handlers) {
      try {
        await handler(event);
      } catch (error) {
        console.error(`assinante de StandingsChangedEvent falhou: ${(error as Error).message}`);
      }
    }
  }
}
