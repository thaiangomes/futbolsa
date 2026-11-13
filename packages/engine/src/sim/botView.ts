import type { StandingRow } from "../engine/dividends.js";
import type { Cents } from "../engine/money.js";
import type { Side } from "../engine/orderbook.js";
import type { Match } from "../engine/types.js";

/**
 * Tudo o que os perfis de bot (`bots.ts`) leem e fazem no mercado: só isto. A simulação (`MarketView`) a implementa
 * sobre o `Exchange` e o `Ledger` em memória; a API ao vivo (F14, `LiveBotView`) a implementa sobre uma leitura do
 * banco e guarda as ordens como intenções. Os perfis não enxergam mais nada além desta interface.
 */
export interface BotView {
  /** O instante, em ms. */
  readonly now: number;
  readonly clubIds: readonly string[];
  /** Torcedores compram o próprio time antes dos mata-matas de copa. */
  readonly cupHype: boolean;

  price(clubId: string): Cents;
  /** Preço de `days` fechamentos diários atrás (ou o mais antigo disponível). */
  priceDaysAgo(clubId: string, days: number): Cents | undefined;
  fairValue(clubId: string): Cents;
  fairValueWith(clubId: string, ppg: (clubId: string) => number): Cents;
  /** Dividendo por ação dos pontos já ganhos e ainda não pagos. */
  unpaidDividend(clubId: string): Cents;
  standing(clubId: string): StandingRow | undefined;
  winStreak(clubId: string): number;
  lastResult(clubId: string): { result: "W" | "D" | "L"; at: number } | undefined;
  nextMatch(clubId: string): Match | undefined;
  nextCupMatch(clubId: string): Match | undefined;
  matchEdge(clubId: string, match: Match, homeBonus?: number): number;

  /** Patrimônio a preços atuais. */
  netWorth(accountId: string): Cents;
  availableCash(accountId: string): Cents;
  availableShares(accountId: string, clubId: string): number;
  /** Caixa total da conta (o analista confere quanto está em ações). */
  cashOf(accountId: string): Cents;

  /** Ordem limitada, com preço mínimo e quantidade ajustados ao saldo livre. */
  limit(accountId: string, clubId: string, side: Side, quantity: number, price: number): void;
  market(accountId: string, clubId: string, side: Side, quantity: number): void;
  /** Cancela as ordens abertas da conta. */
  cancelAll(accountId: string): void;
}
