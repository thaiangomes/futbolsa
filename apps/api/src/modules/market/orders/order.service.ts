import { Inject, Injectable } from "@nestjs/common";
import { DB, type Database, type TransactionOptions, type Tx, withTransaction } from "../../../infra/db/index.js";
import { MatchingEngine, type MatchingHooks, type PlaceOrderInput, type PlaceOrderResult } from "../matching/matching-engine.js";

/** O que só os testes de concorrência passam ao `place`: as pausas do motor e o contador de repetições. */
export interface PlaceOptions {
  hooks?: MatchingHooks;
  /** Repassado ao `withTransaction` (`onRetry` conta as repetições por *deadlock*). */
  transaction?: TransactionOptions;
}

/**
 * A entrada das ordens do jogo (Livro de ofertas e formador de mercado, "Ordens"): a mesma para jogadores, bots e
 * a casa. Quem chama diz a carteira e quem é (`actor`); o motor de ordens (`MatchingEngine`) confere, casa e grava.
 *
 * O resultado é discriminado, sem exceção de regra: `{ ok: true, order, trades, … }` ou `{ ok: false, code, reason? }`
 * com um código de `ORDER_REJECT_CODES`. A ordem recusada não é gravada; a ordem a mercado é gravada mesmo sem
 * negócio, como `cancelled` com `market_remainder` (P4 do Plano do livro de ofertas e formador).
 */
@Injectable()
export class OrderService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly engine: MatchingEngine,
  ) {}

  /**
   * Uma ordem nova dentro da transação de quem chama (a rota, com a chave de idempotência; a reposição da casa,
   * com as cotações velhas já canceladas). A primeira trava é a do clube: a transação pode já ter a temporada,
   * este clube e as carteiras que a ordem alcança, mas nenhuma carteira fora delas.
   */
  placeOrder(tx: Tx, input: PlaceOrderInput, hooks?: MatchingHooks): Promise<PlaceOrderResult> {
    return this.engine.place(tx, input, hooks);
  }

  /** Uma ordem nova na transação dela (`withTransaction`, que repete se o Postgres abortar por *deadlock*). */
  place(input: PlaceOrderInput, options: PlaceOptions = {}): Promise<PlaceOrderResult> {
    return withTransaction(this.db, (tx) => this.placeOrder(tx, input, options.hooks), options.transaction);
  }
}
