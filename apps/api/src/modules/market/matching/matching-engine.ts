import type { OrderRejectCode } from "@futbolsa/contracts";
import type { Cents } from "@futbolsa/engine";
import type { Tx, WalletRow } from "../../../infra/db/index.js";
import type { OrderCancelReason, OrderStatus } from "../../../infra/db/schema/index.js";
import type { PostResult } from "../../portfolio/ledger/index.js";

/**
 * A porta do casamento de ordens (Arquitetura da Fase 1, "Escala"): o módulo `market` fala com o casamento só por
 * aqui. A primeira implementação é a trava da linha do clube no Postgres com as funções puras do motor
 * (`PostgresMatchingEngine`); se um dia o livro for para a memória de um serviço dedicado (F16), ele implementa
 * esta mesma classe, sem mudar as regras nem quem chama.
 *
 * É uma classe abstrata, e não uma `interface`, para servir também de chave de injeção do Nest (como `Clock`).
 */
export abstract class MatchingEngine {
  /**
   * Uma ordem nova, dentro da transação de quem chama. Devolve o que foi gravado ou a recusa; **nunca** lança por
   * regra do jogo. Na recusa nenhuma ordem, negócio ou linha do extrato foi gravada (só a referência do túnel pode
   * ter virado para o dia novo), mas as travas já tomadas (o clube e, às vezes, as carteiras) ficam até o fim da
   * transação.
   *
   * Se o leilão do clube venceu e ainda não foi fechado, devolve `AuctionExpired` sem gravar nada: quem chama
   * termina a transação, fecha o leilão numa transação própria e manda a ordem de novo (P10 do plano).
   */
  abstract place(tx: Tx, input: PlaceOrderInput, hooks?: MatchingHooks): Promise<PlaceOrderAttempt>;

  /**
   * As carteiras (ids) dos donos das ordens que uma ordem limitada nova alcançaria agora, para quem precisa travá-las
   * junto com a própria antes de fazer outra coisa na mesma transação (a troca atômica da edição, critérios 57 a 59: o
   * motor trava as carteiras em ordem de id e recusa travar uma de id menor depois de uma de id maior). Chamar com o
   * clube travado. Ordem inválida, em leilão ou que cruzaria com a própria dona devolve vazio: o `place` a recusa ou a
   * guarda sem casar e não trava nenhuma contraparte. O padrão não alcança ninguém (os motores de teste não precisam).
   */
  async reachOwners(_tx: Tx, _input: PlaceOrderInput): Promise<number[]> {
    return [];
  }
}

/**
 * Quem manda a ordem. Jogador e bot seguem as mesmas regras; a casa (a carteira da tesouraria, pelo formador) não
 * passa pela faixa de 20% nem pelo limite de 50 ordens abertas.
 */
export type OrderActor = "player" | "bot" | "house";

export interface PlaceOrderInput {
  seasonId: number;
  ticker: string;
  walletId: number;
  actor: OrderActor;
  side: "buy" | "sell";
  type: "limit" | "market";
  /** Ações. Quem confere inteiro e maior que zero é o `validateOrder` do motor. */
  quantity: number;
  /** Em centavos; só na ordem limitada. */
  limitPrice?: Cents;
  /** A `Idempotency-Key` da rota, gravada na ordem. */
  idempotencyKey?: string;
  /** O instante da ordem, do relógio da API (`infra/clock`). */
  now: Date;
}

/** Pontos de extensão do `place`. Sem eles, nada muda. */
export interface MatchingHooks {
  /**
   * Só para os testes de concorrência: depois da leitura sem trava da própria carteira e do livro, e antes de
   * travar as carteiras. O teste segura a transação aqui para outra passar na frente e mudar o caixa.
   */
  afterReadBeforeLock?: () => Promise<void>;
  /**
   * A conferência de quem chama, com a carteira de quem manda **já travada** e antes de qualquer gravação: devolve
   * uma recusa, e a ordem para ali, ou nada, e ela segue. É onde a rota recusa a conta bloqueada (`account_blocked`):
   * quem bloqueia trava a carteira antes de cancelar as ordens dela, então a situação lida depois desta trava é a
   * que vale; lida antes, uma ordem poderia passar por um bloqueio que confirma no meio.
   */
  afterWalletsLocked?: (tx: Tx, wallet: WalletRow) => Promise<PlaceOrderRejected | undefined>;
}

/** Uma ordem como ficou gravada em `orders`. */
export interface OrderRecord {
  id: number;
  walletId: number;
  ticker: string;
  side: "buy" | "sell";
  type: "limit" | "market";
  quantity: number;
  filled: number;
  /** Nulo na ordem a mercado. */
  limitPrice: Cents | null;
  /** Caixa que a ordem ainda prende: o que falta executar × o preço limite, só na compra limitada aberta. */
  reservedCash: Cents;
  status: OrderStatus;
  cancelReason: OrderCancelReason | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Um negócio como ficou gravado em `trades`. */
export interface TradeRecord {
  id: number;
  at: Date;
  price: Cents;
  quantity: number;
  buyOrderId: number;
  sellOrderId: number;
  buyerWalletId: number;
  sellerWalletId: number;
  /** A tesouraria está num dos lados. */
  withHouse: boolean;
  /** O preço exibido antes deste negócio (muda a cada negócio da mesma ordem). */
  priceBefore: Cents;
  inAuction: boolean;
}

/** O caixa de uma carteira, em centavos (o desenho do contrato de `POST /orders`). */
export interface CashView {
  total: Cents;
  reserved: Cents;
  free: Cents;
}

export interface PlaceOrderAccepted {
  ok: true;
  /** A ordem que chegou, como ficou: aberta com a sobra, executada, ou cancelada (a sobra da ordem a mercado). */
  order: OrderRecord;
  /** Os negócios da ordem, na ordem em que saíram. */
  trades: TradeRecord[];
  /** As ordens do livro em que os negócios mexeram, como ficaram (para o `order.updated` dos donos). */
  bookOrders: OrderRecord[];
  /** Cada linha gravada no extrato, na ordem, com a carteira e a posição depois dela (para o `wallet.changed`). */
  posts: PostResult[];
  /** As carteiras com extrato novo: a de quem mandou (se mexeu) e as contrapartes. */
  walletIds: number[];
  /** O clube depois da ordem: `price` é o preço exibido (o do último negócio, se houve). */
  club: { clubId: number; ticker: string; price: Cents; priceBefore: Cents };
  /** O caixa de quem mandou, depois da ordem. */
  cash: CashView;
  /**
   * A ordem abriu um leilão: algum negócio dela sairia do túnel de preço, então nada executou, o clube entrou em
   * leilão por 3 horas e ela ficou inteira no livro, com a reserva (critério 39).
   */
  openedAuction: boolean;
  /** O leilão do clube depois da ordem (`until` é quando ele termina; vazio se parado pela suspensão). Nulo fora de leilão. */
  auction: { until: Date | null } | null;
}

export interface PlaceOrderRejected {
  ok: false;
  /** Um dos códigos de `ORDER_REJECT_CODES` do contrato. */
  code: OrderRejectCode;
  /** O motivo da suspensão (do clube ou do mercado todo), que todos veem. Só em `club_suspended`. */
  reason?: string;
}

/** Recusa não é exceção: quem chama decide o que responder (e a rota guarda a recusa na chave de idempotência). */
export type PlaceOrderResult = PlaceOrderAccepted | PlaceOrderRejected;

/**
 * O leilão do clube venceu e ainda não foi fechado (o fim do leilão roda numa tarefa a cada 5 segundos, e a ordem
 * chegou antes dela). A ordem não entra num leilão vencido: nada foi gravado, e quem chama fecha o leilão numa
 * transação própria (`AuctionCloser`) e manda a ordem de novo. Não é recusa: o jogador não vê este estado.
 */
export interface AuctionExpired {
  ok: false;
  auctionExpired: true;
  seasonId: number;
  ticker: string;
  /** Quando o leilão terminou. */
  until: Date;
}

/** O que uma tentativa dentro de uma transação devolve: o resultado da ordem ou o aviso do leilão vencido. */
export type PlaceOrderAttempt = PlaceOrderResult | AuctionExpired;

export function isAuctionExpired(attempt: PlaceOrderAttempt): attempt is AuctionExpired {
  return !attempt.ok && "auctionExpired" in attempt;
}
