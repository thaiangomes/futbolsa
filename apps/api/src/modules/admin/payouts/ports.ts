import { Injectable } from "@nestjs/common";
import type { Tx } from "../../../infra/db/index.js";

/** O que mudou nos eventos de pagamento, para o recálculo dos rankings. */
export interface PayoutsChange {
  seasonId: number;
  /**
   * Os fechamentos dos eventos que nasceram, mudaram de versão, foram substituídos, aprovados ou corrigidos
   * (nas versões trocadas, o antigo e o novo): o "a receber" do mês de cada um muda, inclusive quando o evento
   * nasce depois de o mês fechar.
   */
  closedAts: readonly Date[];
}

/**
 * O que a F12 pede aos rankings (F13), sem conhecê-los (Plano dos dividendos e pagamentos, "Ganchos"; Plano dos
 * rankings, P3 e dúvida 2). A F12 traz esta porta e uma implementação vazia; a F13 troca pela dela.
 */
export abstract class RankingsPort {
  /**
   * Chamado **com o `tx`, dentro da transação** que cria, muda de versão, substitui, aprova ou corrige um evento.
   * A implementação da F13 só grava um pedido de recálculo (o menor fechamento), sem travar nada nem ler histórico:
   * se a transação desfaz, o pedido some junto; se a API cai depois do `COMMIT`, o pedido já está gravado.
   */
  abstract payoutsChanged(tx: Tx, change: PayoutsChange): Promise<void>;

  /** Depois do `COMMIT`: acorda o atendimento do recálculo, sem esperar a tarefa de cada minuto. */
  abstract wake(): Promise<void>;
}

/** Enquanto a F13 não existe: não há ranking a recalcular. */
@Injectable()
export class NoopRankingsPort extends RankingsPort {
  async payoutsChanged(): Promise<void> {}
  async wake(): Promise<void> {}
}
