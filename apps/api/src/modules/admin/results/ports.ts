import { Injectable } from "@nestjs/common";
import type { CompetitionCode } from "@futbolsa/contracts";
import type { Tx } from "../../../infra/db/index.js";
import type { RefreshReason } from "../../../infra/db/schema/values.js";

export type { RefreshReason };

/**
 * O que a F7 pede ao mercado (F9), sem conhecê-lo: a F7 registra uma implementação vazia e a F9 troca
 * por uma de verdade. Os dois métodos recebem o `tx` da ação e gravam a reposição na mesma transação.
 */
export abstract class MarketPort {
  /** Cancela as cotações da casa dos clubes (suspensão): as ordens dos jogadores ficam no livro. */
  abstract cancelHouseQuotes(tx: Tx, tickers: readonly string[]): Promise<void>;
  /** Pede que a casa reponha a cotação dos clubes fora dos horários (placar entrou, correção, retomada). */
  abstract requestRefresh(tx: Tx, tickers: readonly string[], reason: RefreshReason): Promise<void>;
}

/** Enquanto a F9 não existe: não há cotação da casa para cancelar nem repor. */
@Injectable()
export class NoopMarketPort extends MarketPort {
  async cancelHouseQuotes(): Promise<void> {}
  async requestRefresh(): Promise<void> {}
}

/**
 * Os jogos de uma competição mudaram (placar, data, estado). Emitido depois do `COMMIT`; a F12
 * assina para fechar rodadas e fases e refazer a prévia dos pagamentos.
 */
export interface MatchesChangedEvent {
  seasonId: number;
  competition: CompetitionCode;
  matchIds: number[];
  clubIds: number[];
  /** Um placar entrou ou mudou (e não só uma data ou um estado). */
  scoreChanged: boolean;
}

export type MatchesChangedHandler = (event: MatchesChangedEvent) => void | Promise<void>;

/** Quem quiser saber que os jogos mudaram se inscreve aqui. O erro de um assinante não afeta os outros. */
@Injectable()
export class MatchesEvents {
  private readonly handlers: MatchesChangedHandler[] = [];

  subscribe(handler: MatchesChangedHandler): void {
    this.handlers.push(handler);
  }

  async publish(event: MatchesChangedEvent): Promise<void> {
    for (const handler of this.handlers) {
      try {
        await handler(event);
      } catch (error) {
        console.error(`assinante de MatchesChangedEvent falhou: ${(error as Error).message}`);
      }
    }
  }
}
