import { Inject, Injectable, Optional } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import {
  COMMON_ERROR_MESSAGES,
  type CancelOrderResponse,
  type ErrorResponse,
  type ListOrdersResponse,
  type MarketErrorCode,
  type PlaceOrderBody,
  type PlaceOrderResponse,
  placeOrderResponseSchema,
} from "@futbolsa/contracts";
import { Clock } from "../../../infra/clock/index.js";
import { DB, type Database, type Tx, type WalletRow, withTransaction } from "../../../infra/db/index.js";
import { clubs, orders, seasonClubs, users, wallets } from "../../../infra/db/schema/index.js";
import { DomainError } from "../../../infra/http/index.js";
import { currentSeason } from "../../admin/current-season.js";
import {
  isAuctionExpired,
  type AuctionExpired,
  type PlaceOrderInput,
  type PlaceOrderRejected,
  type PlaceOrderResult,
} from "../matching/matching-engine.js";
import { toOrderRecord } from "../matching/settle.js";
import { AuctionCloser } from "../state/tunnel-state.js";
import { CancelService } from "./cancel.service.js";
import { marketError, marketErrorMessage, marketErrorStatus } from "./errors.js";
import {
  claimIdempotencyKey,
  requestHash,
  saveIdempotentResponse,
  type IdempotencyRef,
  type StoredResponse,
} from "./idempotency.js";
import { OrderService } from "./order.service.js";
import { cashOf, listedTicker, myOrderView } from "./views.js";

/** A rota que entra no resumo da chave de idempotência. */
const PLACE_ROUTE = "POST /orders";

/** O status de uma ordem aceita (`POST` que cria). */
const CREATED = 201;

/** Desfaz a transação da ordem que encontrou o leilão do clube vencido: a chave reservada não pode ficar. */
class AuctionExpiredRollback extends Error {
  constructor(readonly expired: AuctionExpired) {
    super(`o leilão de ${expired.ticker} venceu: a ordem é desfeita e repetida depois do fechamento`);
  }
}

/** A carteira do jogador na temporada atual. */
interface PlayerWallet {
  seasonId: number;
  walletId: number;
}

/**
 * As ordens do próprio jogador pelas rotas (T5 e T6 do Plano do livro de ofertas e formador): `POST /orders` com a
 * `Idempotency-Key`, `GET /orders` e `DELETE /orders/:id`. Acha a carteira do usuário na temporada atual e chama a
 * mesma entrada dos bots e da casa (`OrderService.placeOrder`, `CancelService.cancelOrder`); aqui ficam só o que é
 * da rota: a chave de envio, a conta bloqueada e a tradução da recusa em `{ code, message }`.
 */
@Injectable()
export class PlayerOrdersService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly clock: Clock,
    private readonly orders: OrderService,
    private readonly cancels: CancelService,
    /** Quem fecha o leilão vencido (L5). Opcional: sem ele, a ordem que encontra um leilão vencido é erro. */
    @Optional() private readonly auctions?: AuctionCloser,
  ) {}

  /**
   * Uma ordem nova do jogador. A chave de envio, quando vem, é reservada na mesma transação da ordem (P4): a mesma
   * chave com o mesmo corpo devolve a mesma resposta guardada, inclusive a recusa; com outro corpo,
   * `idempotency_conflict`. Sem a chave, a ordem entra sem idempotência.
   *
   * A recusa do motor vira `DomainError` (`{ code, message }`, com o motivo da suspensão na mensagem) e fica guardada
   * na chave. A conta bloqueada é conferida com a carteira já travada (`afterWalletsLocked`).
   *
   * Leilão vencido (P10): a transação é desfeita sem gravar nada (nem a chave), o leilão é fechado numa transação
   * própria e a ordem inteira é repetida numa transação nova, uma vez.
   */
  async place(userId: string, body: PlaceOrderBody, idempotencyKey?: string): Promise<PlaceOrderResponse> {
    const now = this.clock.now();
    const wallet = await this.walletOf(userId);
    // Sem carteira na temporada atual (antes da abertura do IPO, ou conta que ainda não entrou): não há negociação
    // para este jogador. Não é guardado na chave: nada foi tentado.
    if (!wallet) throw marketError("market_closed");
    await this.assertListed(wallet.seasonId, body.ticker);

    const input: PlaceOrderInput = {
      seasonId: wallet.seasonId,
      ticker: body.ticker,
      walletId: wallet.walletId,
      actor: "player",
      side: body.side,
      type: body.type,
      quantity: body.quantity,
      ...(body.type === "limit" ? { limitPrice: body.limitPrice } : {}),
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      now,
    };
    const ref: IdempotencyRef | undefined =
      idempotencyKey === undefined ? undefined : { userId, key: idempotencyKey, requestHash: requestHash(PLACE_ROUTE, body) };

    for (let attempt = 0; ; attempt++) {
      try {
        const response = await withTransaction(this.db, (tx) => this.placeInTransaction(tx, input, ref));
        return answer(response);
      } catch (error) {
        if (!(error instanceof AuctionExpiredRollback)) throw error;
        if (!this.auctions) throw new Error(`o leilão de ${error.expired.ticker} venceu e não há quem o feche (AuctionCloser não registrado)`);
        if (attempt > 0) throw new Error(`o leilão de ${error.expired.ticker} continua vencido depois de fechado`);
        await this.auctions.closeAuction(error.expired.seasonId, error.expired.ticker, now);
      }
    }
  }

  /** As ordens abertas do próprio jogador na temporada atual, da mais antiga para a mais nova. O bloqueado também lê. */
  async listOpen(userId: string): Promise<ListOrdersResponse> {
    const wallet = await this.walletOf(userId);
    if (!wallet) return { orders: [] };
    const rows = await this.db
      .select({ order: orders, ticker: listedTicker })
      .from(orders)
      .innerJoin(clubs, eq(clubs.id, orders.clubId))
      .where(and(eq(orders.walletId, wallet.walletId), eq(orders.status, "open")))
      .orderBy(asc(orders.id));
    return { orders: rows.map((r) => myOrderView(toOrderRecord(r.order, r.ticker))) };
  }

  /**
   * Cancela uma ordem do próprio jogador (`DELETE /orders/:id`). Ordem que não existe ou que é de outra pessoa dá o
   * mesmo `order_not_found`: a resposta não diz se o id existe. Também com o clube suspenso e durante o leilão.
   */
  async cancel(userId: string, orderId: number): Promise<CancelOrderResponse> {
    const wallet = await this.walletOf(userId);
    if (!wallet) throw marketError("order_not_found");
    const result = await this.cancels.cancelOrder({ walletId: wallet.walletId, orderId, now: this.clock.now() });
    if (!result.ok) throw marketError(result.code);
    return { order: myOrderView(result.order), cash: result.cash };
  }

  /** Uma tentativa da ordem, numa transação: a chave, a ordem e a resposta guardada. */
  private async placeInTransaction(tx: Tx, input: PlaceOrderInput, ref: IdempotencyRef | undefined): Promise<StoredResponse> {
    if (ref) {
      const claim = await claimIdempotencyKey(tx, ref, input.now);
      if (claim.kind === "replay") return claim.response;
      if (claim.kind === "conflict") return refusal("idempotency_conflict");
    }
    const result = await this.orders.placeOrder(tx, input, { afterWalletsLocked: (t, w) => refuseInactive(t, w) });
    if (isAuctionExpired(result)) throw new AuctionExpiredRollback(result);
    const response = toStoredResponse(result);
    if (ref) await saveIdempotentResponse(tx, ref, response);
    return response;
  }

  private async walletOf(userId: string): Promise<PlayerWallet | undefined> {
    const season = await currentSeason(this.db);
    if (!season) return undefined;
    const [wallet] = await this.db
      .select({ id: wallets.id })
      .from(wallets)
      .where(and(eq(wallets.seasonId, season.id), eq(wallets.userId, userId)));
    return wallet ? { seasonId: season.id, walletId: wallet.id } : undefined;
  }

  /** Ticker que a temporada não lista: 404, como no livro (`GET /clubs/:ticker/book`). */
  private async assertListed(seasonId: number, ticker: string): Promise<void> {
    const [row] = await this.db
      .select({ clubId: seasonClubs.clubId })
      .from(seasonClubs)
      .innerJoin(clubs, eq(clubs.id, seasonClubs.clubId))
      .where(and(eq(seasonClubs.seasonId, seasonId), eq(clubs.ticker, ticker)));
    if (!row) throw new DomainError("not_found", 404, COMMON_ERROR_MESSAGES.not_found);
  }
}

/**
 * A conta que não está ativa não manda ordem (o bloqueado continua dono do que tem e lê a carteira). Conferido com a
 * carteira já travada: o bloqueio trava a carteira antes de cancelar as ordens dela, então um bloqueio que confirma
 * no meio da ordem é visto aqui (veja `MatchingHooks.afterWalletsLocked`).
 */
async function refuseInactive(tx: Tx, wallet: WalletRow): Promise<PlaceOrderRejected | undefined> {
  if (wallet.ownerType !== "user" || !wallet.userId) throw new Error(`a carteira ${wallet.id} não é de jogador`);
  const [user] = await tx.db.select({ status: users.status }).from(users).where(eq(users.id, wallet.userId));
  return user?.status === "active" ? undefined : { ok: false, code: "account_blocked" };
}

/** O que a chave guarda: a resposta da ordem aceita (conferida pelo contrato) ou o `{ code, message }` da recusa. */
function toStoredResponse(result: PlaceOrderResult): StoredResponse {
  if (!result.ok) return refusal(result.code, result.reason);
  const body: PlaceOrderResponse = {
    order: myOrderView(result.order),
    trades: result.trades.map((t) => ({ id: t.id, at: t.at.toISOString(), price: t.price, quantity: t.quantity })),
    openedAuction: result.openedAuction,
    auction: result.auction ? { until: result.auction.until?.toISOString() ?? null } : null,
    cash: cashOf({ cash: result.cash.total, reservedCash: result.cash.reserved }),
  };
  return { status: CREATED, body: placeOrderResponseSchema.parse(body) };
}

function refusal(code: MarketErrorCode, reason?: string): StoredResponse {
  const body: ErrorResponse = { code, message: marketErrorMessage(code, reason) };
  return { status: marketErrorStatus(code), body };
}

/** A resposta guardada como a rota responde: o corpo da ordem, ou a recusa como `DomainError`. */
function answer(response: StoredResponse): PlaceOrderResponse {
  if (response.status < 400) return response.body as PlaceOrderResponse;
  const error = response.body as ErrorResponse;
  throw new DomainError(error.code, response.status, error.message);
}
