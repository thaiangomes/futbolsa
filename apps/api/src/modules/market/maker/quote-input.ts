import { and, eq } from "drizzle-orm";
import { computeQuote, DEFAULT_MARKET_MAKER, MIN_PRICE, quoteSize, type Cents, type Quote } from "@futbolsa/engine";
import type { Database, DrizzleTx } from "../../../infra/db/index.js";
import { positions, wallets } from "../../../infra/db/schema/index.js";

type Db = Database | DrizzleTx;

/**
 * As entradas da cotação da casa (Livro de ofertas e formador de mercado, "Cotação do formador de mercado"; T10 do
 * Plano do livro de ofertas e formador). A conta é do motor (`computeQuote` e `quoteSize`, com a configuração
 * `DEFAULT_MARKET_MAKER`: âncora no valor justo, faixa de 10% fora de jogo e 14% no modo de jogo, e nunca melhor que
 * o mercado em 5%); aqui se juntam os números que vêm do banco.
 *
 * Os **preços** dependem só do valor justo, do modo de jogo e do preço exibido: a reposição os calcula antes de travar
 * as carteiras, para saber até onde a cotação nova alcança no livro (P1). A **quantidade** de cada lado é a de
 * `quoteSize` com os percentuais e os mínimos de `seasons` (o admin muda; vale na reposição seguinte, critério 34),
 * cortada pelo caixa livre e pelas ações livres da tesouraria, relidos com ela travada.
 */

/** Os valores do formador gravados em `seasons`. */
export interface MakerSettings {
  /** Fora de jogo, em pontos-base das ações do clube (25 = 0,25%). */
  mmQuantityBp: number;
  /** No modo de jogo (6 = 0,06%). */
  mmMatchQuantityBp: number;
  /** O mínimo por lado fora de jogo (10). */
  mmMinSideQty: number;
  /** O mínimo por lado no modo de jogo (3). */
  mmMatchMinSideQty: number;
}

/** O que a tesouraria tem para cotar num clube, já descontado o que as ordens abertas dela prendem. */
export interface TreasuryFunds {
  /** Caixa menos o reservado (as compras da casa nos outros clubes prendem caixa). */
  freeCash: Cents;
  /** Ações do clube menos as reservadas. */
  freeShares: number;
}

/** Caixa e ações "sem fim", para a conta que só quer os preços. */
const UNLIMITED = Number.MAX_SAFE_INTEGER;

/**
 * A âncora da cotação: o valor justo do clube, nunca abaixo de R$ 0,50 (como o `MarketMaker.refresh` da simulação
 * calibrada).
 */
export function quoteReference(fairValue: Cents): Cents {
  return Math.max(MIN_PRICE, fairValue);
}

/**
 * A quantidade máxima por lado: 0,25% das ações do clube fora de jogo e 0,06% no modo de jogo, arredondado para
 * baixo, com o mínimo de 10 e de 3 por lado (critérios 23 e 24). As ações do clube são as da oferta, as do lote do
 * formador e as emitidas para novatos (`total_shares`).
 */
export function houseQuoteSize(settings: MakerSettings, totalShares: number, inMatch: boolean): number {
  return inMatch
    ? quoteSize(totalShares, settings.mmMatchQuantityBp, settings.mmMatchMinSideQty)
    : quoteSize(totalShares, settings.mmQuantityBp, settings.mmMinSideQty);
}

/**
 * Os preços da cotação nova, sem olhar o caixa nem as ações (que só são relidos com a tesouraria travada): a compra e
 * a venda pelo valor justo e pelo modo de jogo, com a regra de nunca ser melhor que o mercado em volta do preço
 * exibido (critérios 12, 36 e 37).
 */
export function quotePrices(reference: Cents, inMatch: boolean, displayedPrice: Cents): { bid: Cents; ask: Cents } {
  const quote = computeQuote(reference, inMatch, UNLIMITED, UNLIMITED, DEFAULT_MARKET_MAKER, { quantity: 1, displayedPrice, bandCap: true });
  return { bid: quote.bid!.price, ask: quote.ask!.price };
}

/**
 * A cotação de verdade, com o que a tesouraria tem livre: sem ações livres do clube, só a compra; sem caixa, só a
 * venda; a compra fica limitada ao que o caixa paga no preço dela (critério 29).
 */
export function houseQuote(q: { reference: Cents; inMatch: boolean; displayedPrice: Cents; size: number; funds: TreasuryFunds }): Quote {
  return computeQuote(q.reference, q.inMatch, q.funds.freeCash, q.funds.freeShares, DEFAULT_MARKET_MAKER, {
    quantity: q.size,
    displayedPrice: q.displayedPrice,
    bandCap: true,
  });
}

/** A carteira da tesouraria da temporada (a casa). Toda temporada em negociação tem uma (a abertura do IPO a cria). */
export async function treasuryWalletId(db: Db, seasonId: number): Promise<number> {
  const [row] = await db
    .select({ id: wallets.id })
    .from(wallets)
    .where(and(eq(wallets.seasonId, seasonId), eq(wallets.ownerType, "treasury")));
  if (!row) throw new Error(`a temporada ${seasonId} não tem tesouraria`);
  return row.id;
}

/** O caixa livre da tesouraria e as ações livres dela no clube. Quem chama já travou a tesouraria. */
export async function readTreasuryFunds(db: Db, treasuryId: number, clubId: number): Promise<TreasuryFunds> {
  const [wallet] = await db.select({ cash: wallets.cash, reservedCash: wallets.reservedCash }).from(wallets).where(eq(wallets.id, treasuryId));
  if (!wallet) throw new Error(`carteira inexistente: ${treasuryId}`);
  const [position] = await db
    .select({ shares: positions.shares, reservedShares: positions.reservedShares })
    .from(positions)
    .where(and(eq(positions.walletId, treasuryId), eq(positions.clubId, clubId)));
  return {
    freeCash: wallet.cash - wallet.reservedCash,
    freeShares: (position?.shares ?? 0) - (position?.reservedShares ?? 0),
  };
}
