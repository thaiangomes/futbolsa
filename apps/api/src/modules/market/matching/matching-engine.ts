import type { OrderRejectCode } from "@futbolsa/contracts";
import type { Cents } from "@futbolsa/engine";
import type { Tx } from "../../../infra/db/index.js";
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
   * regra do jogo. Na recusa nada foi gravado, mas as travas já tomadas (o clube e, às vezes, as carteiras) ficam
   * até o fim da transação.
   */
  abstract place(tx: Tx, input: PlaceOrderInput, hooks?: MatchingHooks): Promise<PlaceOrderResult>;
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

/** Pontos de pausa para os testes de concorrência. Sem eles, nada muda em produção. */
export interface MatchingHooks {
  /**
   * Depois da leitura sem trava da própria carteira e do livro, e antes de travar as carteiras: o teste segura
   * a transação aqui para outra passar na frente e mudar o caixa.
   */
  afterReadBeforeLock?: () => Promise<void>;
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
  /** Túnel de preço (L4): a ordem abriu um leilão e entrou inteira nele. */
  openedAuction: boolean;
  /** Túnel de preço (L4): o leilão do clube depois da ordem (`until` vazio se parado pela suspensão). */
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
