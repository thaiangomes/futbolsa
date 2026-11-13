/**
 * O que impede o encerramento da temporada (Admin, critério 21; F15, T2). Função pura: recebe a contagem de cada
 * pendência, lida pela API com a temporada travada, e devolve um item por motivo, na ordem em que o admin deve
 * resolver. Lista vazia = pode encerrar. Vários motivos aparecem todos.
 *
 * O mês que a tarefa ainda não fechou **não** bloqueia: o encerramento fecha antes, por `closeMonthsDue`.
 */
export type CloseBlockerCode =
  | "buyback_not_closed"
  | "matches_unscored"
  | "payouts_pending"
  | "payouts_settling"
  | "corrections_pending"
  | "buyback_not_approved"
  | "open_orders"
  | "shares_remaining"
  | "recalc_pending"
  | "fraud_open";

export interface CloseState {
  /** A recompra foi fechada (a temporada está em `trading_ended`). */
  tradingEnded: boolean;
  /** Jogos `scheduled` (o adiado não disputado conta como agendado) ou sem placar. */
  matchesUnscored: number;
  /** Eventos de dividendo vigentes aguardando aprovação (a recompra conta à parte). */
  payoutsPending: number;
  /** Eventos aprovados ainda com crédito a lançar (a recompra inclusa). */
  payoutsSettling: number;
  /** Eventos que a correção mudaria com os resultados de agora. */
  correctionEvents: number;
  /** Eventos de recompra vigentes ainda aguardando aprovação. */
  buybackPending: number;
  /** Ordens abertas na temporada (ou carteiras com reserva). */
  openOrders: number;
  /** Carteiras (inclusive a tesouraria) que ainda têm alguma ação. */
  walletsWithShares: number;
  /** Há pedido de recálculo de ranking aberto. */
  recalcPending: boolean;
  /** Casos de trapaça abertos da temporada. */
  fraudOpen: number;
}

export interface CloseBlocker {
  code: CloseBlockerCode;
  /** Quantos itens faltam (1 nos motivos de sim ou não). */
  count: number;
}

export function closeBlockers(state: CloseState): CloseBlocker[] {
  const out: CloseBlocker[] = [];
  const add = (code: CloseBlockerCode, count: number) => {
    if (count > 0) out.push({ code, count });
  };
  if (!state.tradingEnded) out.push({ code: "buyback_not_closed", count: 1 });
  add("matches_unscored", state.matchesUnscored);
  add("payouts_pending", state.payoutsPending);
  add("payouts_settling", state.payoutsSettling);
  add("corrections_pending", state.correctionEvents);
  add("buyback_not_approved", state.buybackPending);
  add("open_orders", state.openOrders);
  add("shares_remaining", state.walletsWithShares);
  add("recalc_pending", state.recalcPending ? 1 : 0);
  add("fraud_open", state.fraudOpen);
  return out;
}
