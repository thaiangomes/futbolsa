import { Inject, Injectable, Optional } from "@nestjs/common";
import { DB, type Database, type TransactionOptions, type Tx, withTransaction } from "../../../infra/db/index.js";
import {
  isAuctionExpired,
  MatchingEngine,
  type MatchingHooks,
  type PlaceOrderAttempt,
  type PlaceOrderInput,
  type PlaceOrderResult,
} from "../matching/matching-engine.js";
import { AuctionCloser } from "../state/tunnel-state.js";

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
    /** Quem fecha o leilão vencido (L5). Opcional: sem ele, a ordem que encontra um leilão vencido é erro. */
    @Optional() private readonly auctions?: AuctionCloser,
  ) {}

  /**
   * Uma ordem nova dentro da transação de quem chama (a rota, com a chave de idempotência; a reposição da casa,
   * com as cotações velhas já canceladas). A primeira trava é a do clube: a transação pode já ter a temporada,
   * este clube e as carteiras que a ordem alcança, mas nenhuma carteira fora delas.
   *
   * Se o leilão do clube venceu e ainda não foi fechado, devolve `AuctionExpired` (veja `isAuctionExpired`) sem
   * ter gravado nada: quem chama **termina ou desfaz a transação sem gravar**, fecha o leilão pelo `AuctionCloser`,
   * numa transação própria, e chama de novo numa transação nova. É o que o `place` faz.
   */
  placeOrder(tx: Tx, input: PlaceOrderInput, hooks?: MatchingHooks): Promise<PlaceOrderAttempt> {
    return this.engine.place(tx, input, hooks);
  }

  /**
   * Uma ordem nova na transação dela (`withTransaction`, que repete se o Postgres abortar por *deadlock*). A ordem
   * que encontra o leilão do clube vencido fecha o leilão antes e é mandada de novo, uma vez (P10): quem chega 2
   * segundos depois do fim nunca entra num leilão vencido, mesmo antes de a tarefa do fim do leilão passar.
   */
  async place(input: PlaceOrderInput, options: PlaceOptions = {}): Promise<PlaceOrderResult> {
    for (let attempt = 0; ; attempt++) {
      const result = await withTransaction(this.db, (tx) => this.placeOrder(tx, input, options.hooks), options.transaction);
      if (!isAuctionExpired(result)) return result;
      if (!this.auctions) throw new Error(`o leilão de ${result.ticker} venceu e não há quem o feche (AuctionCloser não registrado)`);
      if (attempt > 0) throw new Error(`o leilão de ${result.ticker} continua vencido depois de fechado`);
      await this.auctions.closeAuction(result.seasonId, result.ticker, input.now);
    }
  }
}
