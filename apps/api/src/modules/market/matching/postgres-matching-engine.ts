import { Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  breachesTunnel,
  entryReservation,
  matchOrder,
  remainderRelease,
  tunnelBand,
  validateOrder,
  type Cents,
  type IncomingOrder,
  type MatchResult,
  type OrderRequestShape,
  type OrderState,
  type OrderValidation,
  type RestingOrder,
} from "@futbolsa/engine";
import { lockClubs, lockWallets, type LockedClub, type Tx, type WalletRow } from "../../../infra/db/index.js";
import { positions, seasons, wallets } from "../../../infra/db/schema/index.js";
import type { OrderCancelReason, OrderStatus } from "../../../infra/db/schema/index.js";
import { PortfolioLedger } from "../../portfolio/index.js";
import type { PostResult } from "../../portfolio/ledger/index.js";
import { insertOrderRow, myOpenOrdersInClub, readOppositeSide, setClubPrice, type BookOrder } from "../book/book-repo.js";
import { displayedPriceOf } from "../state/displayed-price.js";
import { tradingGate } from "../state/gate.js";
import { auctionExpired, auctionOf, isInAuction, openAuction, rollTunnel } from "../state/tunnel-state.js";
import {
  MatchingEngine,
  type MatchingHooks,
  type OrderRecord,
  type PlaceOrderAccepted,
  type PlaceOrderAttempt,
  type PlaceOrderInput,
  type PlaceOrderRejected,
  type TradeRecord,
} from "./matching-engine.js";
import { ORDER_REF, settleTrade } from "./settle.js";

/** O id da ordem que chega enquanto ela não foi gravada: os ids de `orders` começam em 1. */
const INCOMING_ID = 0;

/** O maior valor de `orders.quantity` (coluna `integer`). */
const MAX_QUANTITY = 2_147_483_647;

/** Caixa "sem limite" para o casamento que só junta os donos das ordens alcançáveis (P1). */
const NO_CASH_LIMIT = Number.MAX_SAFE_INTEGER;

const WALLET_OF_ACTOR = { player: "user", bot: "bot", house: "treasury" } as const;

/** O que a ordem precisa saber da própria carteira: o caixa, as ações do clube e as ordens abertas. */
interface Account {
  wallet: WalletRow;
  shares: number;
  reservedShares: number;
}

/** O outro lado do livro até onde a ordem alcança, e quem é o dono de cada ordem. */
interface Reach {
  resting: RestingOrder[];
  byId: Map<number, BookOrder>;
}

/**
 * O motor de ordens no Postgres (Arquitetura da Fase 1, decisão 4; Plano do livro de ofertas e formador, "Ordem
 * nova, passo a passo"). Uma ordem nova, dentro da transação de quem chama:
 *
 * 1. trava a linha do clube: daqui em diante o livro dele não muda;
 * 2. lê a temporada **depois** dessa trava, sem travá-la (a temporada vem antes dos clubes na ordem das travas; a
 *    suspensão do mercado todo e o fim da negociação travam todos os clubes, então quem esperou pelo clube já vê
 *    o que eles gravaram) e passa pela porta do horário e da suspensão;
 * 3. túnel de preço: se o leilão do clube venceu, sai sem gravar nada (`AuctionExpired`: quem chama fecha o leilão e
 *    repete, P10); senão, a referência do túnel vira para o dia novo de Brasília (P9), e essa é a única gravação
 *    que pode ficar de uma ordem recusada;
 * 4. lê **sem trava** a própria carteira, as ações do clube e as próprias ordens abertas no clube (estas só mudam
 *    com o clube travado) e confere a ordem (`validateOrder` do motor) com o preço exibido da linha travada, o
 *    leilão e o túnel. A ordem recusada nunca abre leilão;
 * 5. fora de leilão, lê o outro lado do livro, em páginas, só até o preço e a quantidade da ordem;
 * 6. junta os donos de **todas** as ordens que o preço e a quantidade alcançam, sem cortar pelo caixa livre (P1),
 *    e trava de uma vez a própria carteira e essas contrapartes (a tesouraria por último). Em leilão não há
 *    contraparte: trava só a própria carteira;
 * 7. relê a própria carteira, já travada: se o caixa, as ações ou as ordens abertas mudaram, confere de novo; e
 *    casa (`matchOrder`) com o caixa de agora. O casamento só alcança carteiras já travadas, porque nunca vai
 *    além do preço e da quantidade do passo 6. Em leilão a ordem não casa. Fora dele, se algum negócio sairia do
 *    túnel, nenhum sai: o clube entra em leilão por 3 horas e a ordem fica inteira no livro (critério 39);
 * 8. grava: a ordem, a reserva da entrada, cada negócio com as duas linhas do extrato, o andamento das ordens do
 *    livro, a sobra (aberta, se limitada; cancelada com `market_remainder`, se a mercado) e o preço do clube.
 *
 * Nenhuma ordem, negócio ou linha do extrato é gravada antes do passo 8: a recusa, em qualquer passo, devolve o
 * código sem ter mexido no caixa, nas ações nem no livro. Candles e eventos do WebSocket não são daqui (T7): o
 * resultado traz os negócios, as ordens e as linhas do extrato.
 *
 * Os negócios daqui gravam `in_auction` falso; os do leilão saem no fim dele (`closeAuction`, L5). As ordens
 * abertas de temporadas passadas não entram no livro porque o fim da negociação cancela todas (`endTrading`): as
 * leituras do livro filtram só pelo clube.
 */
@Injectable()
export class PostgresMatchingEngine extends MatchingEngine {
  /** Ordens lidas por vez do outro lado do livro. */
  pageSize = 200;

  constructor(private readonly ledger: PortfolioLedger) {
    super();
  }

  async place(tx: Tx, input: PlaceOrderInput, hooks?: MatchingHooks): Promise<PlaceOrderAttempt> {
    // 1. O clube travado: o livro e o preço exibido dele não mudam mais nesta transação.
    const club = (await lockClubs(tx, input.seasonId, [input.ticker]))[0]!;

    // 2. A porta do horário e da suspensão, com a temporada lida depois da trava do clube.
    const [season] = await tx.db
      .select({
        status: seasons.status,
        tradingOpensAt: seasons.tradingOpensAt,
        tradingEndedAt: seasons.tradingEndedAt,
        suspendedReason: seasons.suspendedReason,
      })
      .from(seasons)
      .where(eq(seasons.id, input.seasonId));
    if (!season) throw new Error(`temporada inexistente: ${input.seasonId}`);
    const gate = tradingGate(season, club, input.now);
    if (!gate.open) return gate.code === "club_suspended" ? reject(gate.code, gate.reason) : reject(gate.code);
    const at = instantOf(input.now, club.lastTradeAt);

    // 3. O túnel de preço. A ordem não entra num leilão vencido: sai sem gravar nada, e quem chama fecha o leilão
    //    numa transação própria e manda a ordem de novo (fechar aqui travaria as carteiras dos negócios do leilão
    //    depois das que a ordem já tivesse travado, fora da ordem). Depois, a referência do túnel vira para o dia
    //    novo: nenhum negócio saiu antes de ela virar, então o preço exibido lido agora é o das 0h.
    if (auctionExpired(club, at)) {
      return { ok: false, auctionExpired: true, seasonId: input.seasonId, ticker: club.ticker, until: club.auctionUntil! };
    }
    const inAuction = isInAuction(club);
    const tunnel = tunnelBand(await rollTunnel(tx, club, at));

    // 4. A própria carteira, sem trava: as contrapartes ainda não são conhecidas, e todas as carteiras são
    //    travadas juntas, em ordem de id, no passo 6.
    const request = requestOf(input);
    const displayedPrice = displayedPriceOf(club);
    const myOpenOrders = await myOpenOrdersInClub(tx.db, input.walletId, club.clubId);
    const before = await this.readAccount(tx, input, club.clubId);
    const state = (account: Account): OrderState => ({
      displayedPrice,
      cash: account.wallet.cash,
      availableCash: account.wallet.cash - account.wallet.reservedCash,
      availableShares: account.shares - account.reservedShares,
      openOrders: account.wallet.openOrders,
      myOpenOrders,
      isHouse: input.actor === "house",
      // Em leilão a ordem a mercado é recusada (`club_in_auction`). Fora dele, o túnel aperta o teto e o piso da
      // ordem a mercado: ela executa só dentro do túnel e o resto é cancelado, sem abrir leilão (D1).
      inAuction,
      tunnel: inAuction ? undefined : tunnel,
    });

    // As recusas da especificação que não dependem do casamento.
    let validation = validate(request, state(before));
    if (!validation.ok) return reject(validation.code);
    // A casa não tem a faixa de 20%, mas a ordem a mercado dela também para no túnel (D1).
    const marketLimit = (v: { marketPriceLimit?: Cents }): Cents | undefined =>
      v.marketPriceLimit ?? (request.type === "market" && !inAuction ? (request.side === "buy" ? tunnel.max : tunnel.min) : undefined);

    // 5 e 6. O outro lado até onde o preço e a quantidade alcançam, e os donos dessas ordens (P1). Em leilão
    //        nada casa: a limitada entra no livro como está, mesmo cruzando, e espera o preço único.
    const incoming: IncomingOrder = { id: INCOMING_ID, accountId: String(input.walletId), ...request };
    let reach: Reach = { resting: [], byId: new Map() };
    const counterparties = new Set<number>();
    if (!inAuction) {
      reach = await this.readReach(tx, club.clubId, request, marketLimit(validation));
      const widest = matchOrder(reach.resting, incoming, {
        selfTrade: "reject",
        availableCash: NO_CASH_LIMIT,
        marketPriceLimit: marketLimit(validation),
      });
      if (widest.status === "rejected") return reject("self_trade");
      for (const fill of widest.fills) counterparties.add(reach.byId.get(fill.restingId)!.walletId);
    }

    if (hooks?.afterReadBeforeLock) await hooks.afterReadBeforeLock();

    const locked = await lockWallets(tx, [input.walletId, ...counterparties]);
    const houseWallets = new Set(locked.filter((w) => w.ownerType === "treasury").map((w) => w.id));
    const own = locked.find((w) => w.id === input.walletId)!;

    // A conferência de quem chama, com a carteira travada (a rota recusa aqui a conta bloqueada).
    if (hooks?.afterWalletsLocked) {
      const refusal = await hooks.afterWalletsLocked(tx, own);
      if (refusal) return refusal;
    }

    // 7. A própria carteira de novo, agora travada. As contrapartes não precisam: o que as ordens delas prendem
    //    (caixa ou ações) só é solto com o clube travado.
    const account = await this.readAccount(tx, input, club.clubId, own);
    if (changed(before, account)) {
      validation = validate(request, state(account));
      if (!validation.ok) return reject(validation.code);
    }

    let match = unmatched(request);
    let openedAuction = false;
    let auction = auctionOf(club);
    if (!inAuction) {
      match = matchOrder(reach.resting, incoming, {
        selfTrade: "reject",
        availableCash: account.wallet.cash - account.wallet.reservedCash,
        marketPriceLimit: marketLimit(validation),
      });
      if (match.status === "rejected") return reject("self_trade");

      // A ordem que executaria alguma parte fora do túnel não executa nada: o clube entra em leilão e ela entra
      // inteira nele, com a reserva (critério 39; a cotação da casa também, D2). As carteiras das contrapartes
      // ficam travadas sem uso até o COMMIT, o que não muda a ordem das travas.
      if (breachesTunnel(match.fills, tunnel)) {
        if (request.type !== "limit") throw new Error("ordem a mercado com negócio fora do túnel: o teto dela devia ser o do túnel");
        auction = { until: await openAuction(tx, club, at) };
        openedAuction = true;
        match = unmatched(request);
      }
    } else if (request.type !== "limit") {
      throw new Error("ordem a mercado passou pela conferência com o clube em leilão");
    }

    // 8. Só agora o livro, o caixa e as ações mudam.
    const recorded = await this.record(tx, { input, at, request, club, displayedPrice, account, reach, match, houseWallets });
    return { ...recorded, openedAuction, auction };
  }

  /**
   * A carteira de quem manda (a linha já travada, quando houver) e as ações dela no clube. Confere que a carteira
   * é desta temporada e do tipo que o `actor` diz: a casa é a tesouraria, e só ela escapa da faixa de 20% e do
   * limite de 50 ordens.
   */
  private async readAccount(tx: Tx, input: PlaceOrderInput, clubId: number, lockedRow?: WalletRow): Promise<Account> {
    const wallet = lockedRow ?? (await tx.db.select().from(wallets).where(eq(wallets.id, input.walletId)))[0];
    if (!wallet) throw new Error(`carteira inexistente: ${input.walletId}`);
    if (wallet.seasonId !== input.seasonId) {
      throw new Error(`a carteira ${wallet.id} é da temporada ${wallet.seasonId}, e a ordem veio para a ${input.seasonId}`);
    }
    if (wallet.ownerType !== WALLET_OF_ACTOR[input.actor]) {
      throw new Error(`ordem de "${input.actor}" com a carteira ${wallet.id}, que é de "${wallet.ownerType}"`);
    }
    const [position] = await tx.db
      .select({ shares: positions.shares, reservedShares: positions.reservedShares })
      .from(positions)
      .where(and(eq(positions.walletId, wallet.id), eq(positions.clubId, clubId)));
    return { wallet, shares: position?.shares ?? 0, reservedShares: position?.reservedShares ?? 0 };
  }

  /**
   * O outro lado do livro em ordem de prioridade, em páginas, só até o preço da ordem (o limite da limitada ou o
   * teto/piso da ordem a mercado) e até somar a quantidade pedida: mais que isso a ordem não alcança, com caixa
   * ou sem.
   */
  private async readReach(tx: Tx, clubId: number, request: OrderRequestShape, marketPriceLimit: Cents | undefined): Promise<Reach> {
    const price = request.type === "limit" ? request.limitPrice : marketPriceLimit;
    const book: BookOrder[] = [];
    let quantity = 0;
    while (quantity < request.quantity) {
      const page = await readOppositeSide(tx.db, { clubId, incomingSide: request.side, price, after: book.at(-1) }, this.pageSize);
      for (const order of page) {
        book.push(order);
        quantity += order.remaining;
      }
      if (page.length < this.pageSize) break;
    }
    return {
      resting: book.map((o) => ({ id: o.id, accountId: String(o.walletId), side: o.side, limitPrice: o.limitPrice, remaining: o.remaining })),
      byId: new Map(book.map((o) => [o.id, o])),
    };
  }

  /** O passo 8: grava a ordem e o que o casamento decidiu. */
  private async record(
    tx: Tx,
    r: {
      input: PlaceOrderInput;
      /** O instante de tudo o que a ordem grava. */
      at: Date;
      request: OrderRequestShape;
      club: LockedClub;
      displayedPrice: Cents;
      account: Account;
      reach: Reach;
      match: MatchResult;
      houseWallets: ReadonlySet<number>;
    },
  ): Promise<PlaceOrderAccepted> {
    const { input, at, request, club, match } = r;
    const limitPrice = request.type === "limit" ? request.limitPrice! : null;
    const buying = request.side === "buy";

    // A ordem entra já como termina: executada, aberta com a sobra (limitada) ou cancelada (a sobra da ordem a
    // mercado nunca fica no livro). A ordem a mercado é gravada mesmo sem nenhum negócio, para a auditoria (P4).
    const status: OrderStatus = match.remaining === 0 ? "filled" : match.rests ? "open" : "cancelled";
    const cancelReason: OrderCancelReason | null = status === "cancelled" ? "market_remainder" : null;
    const order: OrderRecord = {
      id: INCOMING_ID,
      walletId: input.walletId,
      ticker: club.ticker,
      side: request.side,
      type: request.type,
      quantity: request.quantity,
      filled: request.quantity - match.remaining,
      limitPrice,
      // A compra limitada aberta prende o que falta executar × o preço limite.
      reservedCash: match.rests && buying ? match.remaining * limitPrice! : 0,
      status,
      cancelReason,
      createdAt: at,
      updatedAt: at,
    };
    order.id = await insertOrderRow(tx, {
      seasonId: input.seasonId,
      clubId: club.clubId,
      walletId: order.walletId,
      side: order.side,
      type: order.type,
      quantity: order.quantity,
      filled: order.filled,
      limitPrice: order.limitPrice,
      reservedCash: order.reservedCash,
      status: order.status,
      cancelReason: order.cancelReason,
      at,
      idempotencyKey: input.idempotencyKey,
    });
    const ref = { type: ORDER_REF, id: order.id };
    const posts: PostResult[] = [];

    // A reserva da entrada: a compra limitada prende quantidade × limite e a venda prende as ações; a compra a
    // mercado não prende nada. A limitada que vai ficar no livro passa a contar nas ordens abertas da carteira.
    const entry = entryReservation(request);
    if (entry.reservedCash !== 0 || entry.reservedShares !== 0) {
      posts.push(
        await this.ledger.post(tx, {
          walletId: input.walletId,
          at,
          kind: "order_reserve",
          clubId: club.clubId,
          reservedCashDelta: entry.reservedCash,
          reservedSharesDelta: entry.reservedShares,
          openOrdersDelta: match.rests ? 1 : 0,
          ref,
        }),
      );
    }

    // Cada negócio, pelo preço da ordem que já estava no livro. O preço exibido anda a cada um deles.
    const trades: TradeRecord[] = [];
    const bookOrders = new Map<number, OrderRecord>();
    let price = r.displayedPrice;
    for (const fill of match.fills) {
      const resting = r.reach.byId.get(fill.restingId)!;
      const mine = { orderId: order.id, walletId: input.walletId, type: request.type, limitPrice, resting: false };
      const theirs = { orderId: resting.id, walletId: resting.walletId, type: "limit" as const, limitPrice: resting.limitPrice, resting: true };
      const settled = await settleTrade(tx, this.ledger, {
        seasonId: input.seasonId,
        clubId: club.clubId,
        ticker: club.ticker,
        at,
        price: fill.price,
        quantity: fill.quantity,
        buy: buying ? mine : theirs,
        sell: buying ? theirs : mine,
        withHouse: r.houseWallets.has(input.walletId) || r.houseWallets.has(resting.walletId),
        priceBefore: price,
        inAuction: false,
      });
      trades.push(settled.trade);
      posts.push(...settled.posts);
      for (const o of settled.bookOrders) bookOrders.set(o.id, o);
      price = fill.price;
    }

    // A sobra da ordem a mercado é cancelada: a venda devolve as ações que tinha prendido.
    if (status === "cancelled") {
      const release = remainderRelease(request, match.remaining);
      if (release.reservedCash !== 0 || release.reservedShares !== 0) {
        posts.push(
          await this.ledger.post(tx, {
            walletId: input.walletId,
            at,
            kind: "order_release",
            clubId: club.clubId,
            reservedCashDelta: release.reservedCash,
            reservedSharesDelta: release.reservedShares,
            ref,
          }),
        );
      }
    }

    // O preço exibido passa a ser o do último negócio, inclusive com a casa.
    if (trades.length > 0) await setClubPrice(tx, input.seasonId, club.clubId, price, at);

    // A carteira de quem mandou depois da última linha dela (sem linha nenhuma, a que foi travada).
    let wallet = r.account.wallet;
    for (const p of posts) if (p.wallet.id === input.walletId) wallet = p.wallet;
    return {
      ok: true,
      order,
      trades,
      bookOrders: [...bookOrders.values()],
      posts,
      walletIds: [...new Set(posts.map((p) => p.wallet.id))],
      club: { clubId: club.clubId, ticker: club.ticker, price, priceBefore: r.displayedPrice },
      cash: { total: wallet.cash, reserved: wallet.reservedCash, free: wallet.cash - wallet.reservedCash },
      openedAuction: false,
      auction: null,
    };
  }
}

/**
 * O instante da ordem: o `now` de quem chama, mas nunca antes do último negócio do clube. Quem chama lê o relógio
 * antes de esperar a trava do clube; com duas ordens quase juntas, a que leu o relógio primeiro pode pegar a trava
 * depois, e o negócio dela sairia com horário anterior ao do negócio que ela encontrou feito. O preço do passado
 * (`lastTradeUntil`) segue o horário e o `last_price` segue a ordem da trava: os dois só concordam se o horário dos
 * negócios de um clube nunca recuar. O fim do leilão (L5) usa a mesma conta.
 */
export function instantOf(now: Date, lastTradeAt: Date | null): Date {
  return lastTradeAt !== null && lastTradeAt.getTime() > now.getTime() ? lastTradeAt : now;
}

/** A ordem que entra no livro sem nenhum negócio: em leilão, ou a que abriu o leilão. Só a limitada. */
function unmatched(request: OrderRequestShape): MatchResult {
  return { status: "resting", fills: [], remaining: request.quantity, rests: true };
}

function reject(code: PlaceOrderRejected["code"], reason?: string): PlaceOrderRejected {
  return reason === undefined ? { ok: false, code } : { ok: false, code, reason };
}

/** A ordem como o motor a confere: a ordem a mercado não tem preço. */
function requestOf(input: PlaceOrderInput): OrderRequestShape {
  const base = { side: input.side, type: input.type, quantity: input.quantity };
  return input.type === "limit" ? { ...base, limitPrice: input.limitPrice } : base;
}

/**
 * As recusas do motor (`validateOrder`) e uma do banco: a quantidade que não cabe em `orders.quantity`. Sem ela, uma
 * compra a mercado de bilhões de ações passaria (ela não reserva nada) e quebraria na gravação.
 */
function validate(request: OrderRequestShape, state: OrderState): OrderValidation {
  if (Number.isSafeInteger(request.quantity) && request.quantity > MAX_QUANTITY) return { ok: false, code: "invalid_quantity" };
  return validateOrder(request, state);
}

/** Se o que a ordem leu da própria carteira sem trava já não vale com ela travada. */
function changed(before: Account, now: Account): boolean {
  return (
    before.wallet.cash !== now.wallet.cash ||
    before.wallet.reservedCash !== now.wallet.reservedCash ||
    before.wallet.openOrders !== now.wallet.openOrders ||
    before.shares !== now.shares ||
    before.reservedShares !== now.reservedShares
  );
}
