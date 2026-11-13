import type { Cents } from "@futbolsa/engine";
import type { EntryMode, WalletEntryKind } from "../../../infra/db/schema/index.js";

/**
 * Um movimento numa carteira. Quem chama decide *quanto* (o `market` quanto
 * reservar, o `ipo` quanto pagar, o `admin` quanto estornar); o `post` aplica e grava.
 */
export interface Movement {
  walletId: number;
  /** Do relógio da API. */
  at: Date;
  kind: WalletEntryKind;
  /** Obrigatório se mexe em ações ou é dividendo, estorno, complemento ou anulação de negócio de um clube. */
  clubId?: number;
  cashDelta?: Cents;
  reservedCashDelta?: Cents;
  sharesDelta?: number;
  reservedSharesDelta?: number;
  /** Preço do negócio, de corte do IPO, de referência ou exibido. */
  price?: Cents;
  /**
   * Como as ações que entram ou saem mexem no custo: `purchase` soma (negócio,
   * IPO, carteira índice, crédito do admin pelo preço exibido); `sale` tira na
   * proporção com resultado realizado (venda, recompra); `debit` tira na proporção
   * sem resultado (débito do admin). Obrigatório quando `sharesDelta` não é zero, menos na anulação.
   */
  costBasis?: "purchase" | "sale" | "debit";
  /**
   * Só na linha `trade_annulled` (negócio anulado por trapaça, propostas 16 a 18 do Plano do admin de jogadores
   * e bots), e nela obrigatório: o custo e o resultado realizado da posição do clube depois do desfazer, já
   * refeitos por quem chama com `replayCost` do motor, como se o negócio (ou a parte que voltou) não tivesse
   * existido. Valem no lugar da conta do `costBasis`, que a anulação não leva; o resultado da linha do extrato é
   * a diferença para o realizado de antes.
   */
  annulled?: { cost: Cents; realized: Cents };
  /** O `market` conta as ordens abertas para o limite de 50. */
  openOrdersDelta?: number;
  ref?: { type: string; id: number | string };
  reason?: string;
}

export type WalletOwner = { type: "user"; userId: string } | { type: "bot"; botId: number } | { type: "treasury" };

export interface OpenWallet {
  seasonId: number;
  owner: WalletOwner;
  at: Date;
  entryMode?: EntryMode;
  /** Caixa inicial, com a linha `initial` do extrato (R$ 100.000,00 = 10.000.000). */
  initialCash?: Cents;
}
