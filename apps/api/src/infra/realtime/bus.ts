import type { SubscribeMode, Channel, EventType } from "@futbolsa/contracts";
import type { ZodType } from "zod";

/** O canal `me` de uma pessoa: o `seq` e o histórico são por pessoa, e só ela assina. */
export interface MeStream {
  channel: "me";
  userId: string;
}

export function meChannel(userId: string): MeStream {
  return { channel: "me", userId };
}

/** Onde se publica e se assina: um canal público (`prices`, `club:FLA3`...) ou o `me` de alguém. */
export type Stream = Channel | MeStream;

/** Um evento já pronto para enviar: o quadro JSON é montado uma vez e serve a todos os assinantes. */
export interface BusEvent {
  seq: number;
  frame: string;
}

export type BusListener = (event: BusEvent) => void;

export interface BusSubscription {
  /** `live`: sem `since`. `resumed`: `replay` tem o que faltou. `resync`: o cliente recarrega pela REST. */
  mode: SubscribeMode;
  /** O `seq` do canal no momento da assinatura. */
  seq: number;
  /** O que o cliente perdeu desde o `since`, em ordem. O gateway envia isto logo depois do `subscribed`. */
  replay: BusEvent[];
  unsubscribe(): void;
}

/**
 * O barramento de eventos do jogo. Os módulos só falam com ele (`publish` e `currentSeq`);
 * o gateway assina. A versão em memória serve a uma instância da API; com mais de uma, a
 * troca é por `LISTEN/NOTIFY` do Postgres, sem mexer nos módulos.
 */
export abstract class EventBus {
  /**
   * Publica um evento. O tipo tem que pertencer ao canal (catálogo dos contratos) e, se o
   * módulo dono registrou o esquema do `data`, o conteúdo é conferido. Quem chama dentro de
   * uma transação publica em `tx.afterCommit`, nunca antes do `COMMIT`.
   */
  abstract publish(stream: Stream, type: EventType, data: unknown): void;

  /**
   * O `seq` do último evento do canal. A rota REST que devolve uma foto lê isto **antes** de
   * ler o banco: no pior caso o cliente recebe de novo um evento que a foto já continha.
   */
  abstract currentSeq(stream: Stream): number;

  /**
   * Assina o canal. A retomada (`since`) roda aqui, de uma vez só: devolve o que faltou e já
   * deixa o `listener` registrado, então nenhum evento novo cai entre o reenvio e o ao vivo.
   */
  abstract subscribe(stream: Stream, listener: BusListener, since?: number): BusSubscription;

  /** O módulo dono registra o esquema do `data` de um tipo de evento. */
  abstract registerSchema(type: EventType, schema: ZodType): void;
}
