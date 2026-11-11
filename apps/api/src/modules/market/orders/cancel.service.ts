import { Inject, Injectable, Optional } from "@nestjs/common";
import { and, asc, eq, inArray } from "drizzle-orm";
import { DB, type Database, lockClubs, lockWallets, type TransactionOptions, type Tx, withTransaction } from "../../../infra/db/index.js";
import { clubs, orders } from "../../../infra/db/schema/index.js";
import type { OrderCancelReason } from "../../../infra/db/schema/index.js";
import { PortfolioLedger } from "../../portfolio/index.js";
import type { PostResult } from "../../portfolio/ledger/index.js";
import { updateOrderProgress } from "../book/book-repo.js";
import type { CashView, OrderRecord } from "../matching/matching-engine.js";
import { ORDER_REF, toOrderRecord } from "../matching/settle.js";
import { MarketEvents } from "../realtime/events.js";
import { AuctionCloser, auctionExpired } from "../state/tunnel-state.js";
import { cashOf, listedTicker } from "./views.js";

type OrderRow = typeof orders.$inferSelect;

export interface CancelOrderInput {
  /** A carteira de quem pede: só o dono cancela a ordem. */
  walletId: number;
  orderId: number;
  /** O instante do pedido, do relógio da API. */
  now: Date;
}

export type CancelOrderResult =
  | {
      ok: true;
      /** A ordem como ficou: `cancelled`, motivo `player`, sem reserva. */
      order: OrderRecord;
      /** A linha `order_release` do extrato (para o `wallet.changed` do dono, T7). */
      posts: PostResult[];
      /** O caixa do dono depois da devolução. */
      cash: CashView;
    }
  /** `order_not_found`: a ordem não existe ou é de outra pessoa (a resposta não diz qual). `order_not_open`: já executou ou foi cancelada. */
  | { ok: false; code: "order_not_found" | "order_not_open" };

/** Quais ordens abertas da carteira `cancelOrders` cancela. Sem filtro, todas. */
export interface CancelFilter {
  /** Só as de um lado (o estorno da F12 cancela só as compras). */
  side?: "buy" | "sell";
  /** Só as destes clubes. */
  tickers?: readonly string[];
}

export interface CancelledOrders {
  /** As ordens canceladas, como ficaram, em ordem de id. */
  orders: OrderRecord[];
  /** As linhas `order_release` do extrato, uma por ordem, na mesma ordem. */
  posts: PostResult[];
}

/** Só para os testes de concorrência: a pausa antes da trava do clube. */
export interface CancelOptions {
  beforeClubLock?: () => Promise<void>;
  transaction?: TransactionOptions;
}

/**
 * Uma ordem aberta num clube que a transação não travou. A lista de clubes de quem chama (`clubsToLock`) foi lida
 * sem trava, e uma ordem nova entrou noutro clube antes de a carteira ser travada. Cancelá-la sem a trava do clube
 * quebraria a regra de que o livro só muda com o clube travado (uma ordem nesse clube pode ter lido o livro e estar
 * esperando esta carteira para liquidar). O código é o do conflito de serialização do Postgres (`40001`): o
 * `withTransaction` desfaz e repete a transação inteira, que na nova leitura trava o clube que faltou.
 */
export class ClubsNotLockedError extends Error {
  readonly code = "40001";
  constructor(readonly tickers: readonly string[]) {
    super(`ordens abertas em clubes não travados por esta transação: ${tickers.join(", ")}`);
    this.name = "ClubsNotLockedError";
  }
}

/** O cancelamento achou o leilão do clube vencido: nada foi gravado, e o leilão fecha antes (P10). */
interface Expired {
  expired: { seasonId: number; ticker: string };
}

/**
 * Cancelar ordens (Livro de ofertas e formador de mercado, critério 16; T6 do plano). A ordem cancelada sai do livro,
 * a reserva volta para o livre (o caixa da compra limitada, as ações da venda) pelo `portfolio.post` com
 * `order_release`, e a carteira passa a ter uma ordem aberta a menos. O motivo fica em `orders.cancel_reason`.
 *
 * - `cancelOrder`: o dono cancela uma ordem (`DELETE /orders/:id`), na transação dela. Aceito também com o clube
 *   suspenso (Admin, critério 24) e durante o leilão (critério 41): cancelar não executa nada.
 * - `cancelOrders`: o jogo cancela várias ordens de uma carteira dentro da transação de quem chama (exclusão e
 *   bloqueio da conta, estorno da F12, bot desligado, fim da negociação), com os clubes já travados.
 *
 * As travas seguem a ordem do jogo: o clube antes da carteira. Quem cancela só sabe o clube depois de ler a ordem,
 * então lê sem trava, trava o clube e lê de novo (a ordem só muda com o clube travado).
 */
@Injectable()
export class CancelService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly ledger: PortfolioLedger,
    /** Quem fecha o leilão vencido (L5). Opcional: sem ele, o cancelamento que encontra um leilão vencido é erro. */
    @Optional() private readonly auctions?: AuctionCloser,
    /**
     * Os avisos depois do `COMMIT` (T7): `order.updated` e `wallet.changed` do dono e o livro do clube marcado como
     * sujo. Opcional: sem ele o cancelamento não avisa ninguém.
     */
    @Optional() private readonly events?: MarketEvents,
  ) {}

  /**
   * O dono cancela uma ordem aberta. Passos: lê a ordem sem trava (para saber o clube); trava o clube; se o leilão
   * dele venceu e não foi fechado, desiste sem gravar nada, fecha o leilão numa transação própria e repete uma vez
   * (P10: a ordem que estava no leilão pode ter executado no fim dele); lê a ordem de novo com o clube travado; trava
   * a carteira; cancela e devolve a reserva do que faltava executar.
   */
  async cancelOrder(input: CancelOrderInput, options: CancelOptions = {}): Promise<CancelOrderResult> {
    const [found] = await this.db
      .select({ walletId: orders.walletId, seasonId: orders.seasonId, ticker: listedTicker })
      .from(orders)
      .innerJoin(clubs, eq(clubs.id, orders.clubId))
      .where(eq(orders.id, input.orderId));
    if (!found || found.walletId !== input.walletId) return { ok: false, code: "order_not_found" };

    for (let attempt = 0; ; attempt++) {
      const outcome = await withTransaction(
        this.db,
        async (tx): Promise<CancelOrderResult | Expired> => {
          if (options.beforeClubLock) await options.beforeClubLock();
          const [club] = await lockClubs(tx, found.seasonId, [found.ticker]);
          if (auctionExpired(club!, input.now)) return { expired: { seasonId: found.seasonId, ticker: found.ticker } };

          const [row] = await tx.db.select().from(orders).where(eq(orders.id, input.orderId));
          if (!row || row.walletId !== input.walletId) return { ok: false, code: "order_not_found" };
          if (row.status !== "open") return { ok: false, code: "order_not_open" };

          const [wallet] = await lockWallets(tx, [row.walletId]);
          const { order, post } = await this.release(tx, row, found.ticker, "player", input.now);
          await this.events?.ordersChanged(tx, found.ticker, [order], [post]);
          return { ok: true, order, posts: [post], cash: cashOf(post.wallet ?? wallet!) };
        },
        options.transaction,
      );
      if (!("expired" in outcome)) return outcome;
      if (!this.auctions) throw new Error(`o leilão de ${outcome.expired.ticker} venceu e não há quem o feche (AuctionCloser não registrado)`);
      if (attempt > 0) throw new Error(`o leilão de ${outcome.expired.ticker} continua vencido depois de fechado`);
      await this.auctions.closeAuction(outcome.expired.seasonId, outcome.expired.ticker, input.now);
    }
  }

  /**
   * Cancela as ordens abertas da carteira que passam pelo filtro, com o motivo dado, na transação de quem chama.
   * Quem chama **já travou os clubes** das ordens (como o `ClosureHook`, pelo `clubsToLock`); aqui a carteira é
   * travada (se ainda não foi) e as ordens são lidas depois dessa trava: ordem nova e negócio contra as ordens dela
   * precisam desta carteira, então a lista não muda mais até o `COMMIT`. Uma ordem num clube que a transação não
   * travou dá `ClubsNotLockedError`, e o `withTransaction` repete a transação inteira.
   *
   * O leilão vencido não é fechado aqui (as travas da transação de quem chama já foram tomadas): a ordem é cancelada
   * como se o pedido tivesse chegado antes do fim do leilão.
   */
  async cancelOrders(tx: Tx, walletId: number, filter: CancelFilter, reason: OrderCancelReason, at: Date): Promise<CancelledOrders> {
    await lockWallets(tx, [walletId]);
    if (filter.tickers && filter.tickers.length === 0) return { orders: [], posts: [] };
    const rows = await tx.db
      .select({ order: orders, ticker: listedTicker })
      .from(orders)
      .innerJoin(clubs, eq(clubs.id, orders.clubId))
      .where(
        and(
          eq(orders.walletId, walletId),
          eq(orders.status, "open"),
          filter.side ? eq(orders.side, filter.side) : undefined,
          filter.tickers ? inArray(clubs.ticker, [...filter.tickers]) : undefined,
        ),
      )
      .orderBy(asc(orders.id));
    const unlocked = [...new Set(rows.map((r) => r.ticker).filter((t) => !tx.locks.isClubLocked(t)))];
    if (unlocked.length > 0) throw new ClubsNotLockedError(unlocked.sort());

    const out: CancelledOrders = { orders: [], posts: [] };
    for (const { order: row, ticker } of rows) {
      const { order, post } = await this.release(tx, row, ticker, reason, at);
      out.orders.push(order);
      out.posts.push(post);
    }
    // Os avisos por clube: o livro de cada um muda, e cada dono recebe as ordens dele.
    if (this.events) {
      for (const ticker of new Set(rows.map((r) => r.ticker))) {
        const changed = out.orders.flatMap((o, i) => (o.ticker === ticker ? [{ order: o, post: out.posts[i]! }] : []));
        await this.events.ordersChanged(tx, ticker, changed.map((c) => c.order), changed.map((c) => c.post));
      }
    }
    return out;
  }

  /**
   * Cancela uma ordem aberta já relida com o clube e a carteira travados: `cancelled` com o motivo, sem reserva, e a
   * linha `order_release` que devolve o que ela prendia (o caixa gravado na ordem, na compra limitada; as ações que
   * faltavam vender, na venda) e tira uma das ordens abertas da carteira.
   */
  private async release(tx: Tx, row: OrderRow, ticker: string, reason: OrderCancelReason, at: Date): Promise<{ order: OrderRecord; post: PostResult }> {
    if (row.status !== "open") throw new Error(`a ordem ${row.id} não está aberta`);
    const remaining = row.quantity - row.filled;
    await updateOrderProgress(tx, row.id, { filled: row.filled, status: "cancelled", reservedCash: 0, at, cancelReason: reason });
    const post = await this.ledger.post(tx, {
      walletId: row.walletId,
      at,
      kind: "order_release",
      clubId: row.clubId,
      reservedCashDelta: -row.reservedCash,
      reservedSharesDelta: row.side === "sell" ? -remaining : 0,
      openOrdersDelta: -1,
      ref: { type: ORDER_REF, id: row.id },
    });
    const order: OrderRecord = { ...toOrderRecord(row, ticker), status: "cancelled", reservedCash: 0, cancelReason: reason, updatedAt: at };
    return { order, post };
  }
}
