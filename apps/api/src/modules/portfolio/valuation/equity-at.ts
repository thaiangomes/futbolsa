import { eq } from "drizzle-orm";
import { equity as engineEquity, type Cents } from "@futbolsa/engine";
import type { Tx } from "../../../infra/db/transaction.js";
import { seasons } from "../../../infra/db/schema/index.js";
import { balancesAt, holdingsAt } from "./readers/balances-at.js";
import { payablesAt } from "./readers/payables-at.js";
import { pricesAt } from "./readers/prices-at.js";

export interface HeldPosition {
  clubId: number;
  ticker: string;
  shares: number;
  /** O preço exibido do clube no instante. */
  price: Cents;
}

/** O patrimônio de uma carteira num instante, com as peças da conta. */
export interface WalletEquity {
  walletId: number;
  cash: Cents;
  /** O reservado de **agora** (não o de T): não entra no patrimônio, serve à tela da carteira. */
  reserved: Cents;
  positions: HeldPosition[];
  /** Dividendos e recompra a receber, total e por clube. */
  receivable: Cents;
  receivableByClub: Map<number, Cents>;
  buybackClosed: boolean;
  equity: Cents;
}

export interface EquityAtOptions {
  /** Só estas carteiras (padrão: todas as de jogadores e bots da temporada, nunca a tesouraria). */
  wallets?: readonly number[];
}

/**
 * O patrimônio de cada carteira da temporada num instante T (P2 do Plano da carteira e gráficos): caixa total + ações ×
 * preço exibido + a receber, com a recompra fechada valendo R$ 0,00 nas ações. É a **única** implementação: a carteira,
 * o ponto diário, a foto mensal e os rankings (F13) usam esta.
 *
 * Roda **dentro da transação de quem chama**: recebe o `tx`, não abre transação, não trava nada e não escolhe o
 * isolamento (por isso nunca pede outra conexão ao conjunto: com as carteiras travadas pelo chamador, uma segunda
 * conexão esperaria para sempre). O número de consultas não depende do número de carteiras. Só `SELECT` (P3).
 */
export const EquityAt = {
  async forSeason(tx: Tx, seasonId: number, at: Date, options: EquityAtOptions = {}): Promise<Map<number, WalletEquity>> {
    const [season] = await tx.db.select({ tradingEndedAt: seasons.tradingEndedAt }).from(seasons).where(eq(seasons.id, seasonId));
    if (!season) throw new Error(`temporada ${seasonId} não existe`);
    const buybackClosed = season.tradingEndedAt !== null && season.tradingEndedAt.getTime() <= at.getTime();

    // em sequência: o `tx` é uma conexão só, então as consultas não correm juntas de verdade
    const balances = await balancesAt(tx, seasonId, at, options.wallets);
    const holdings = await holdingsAt(tx, seasonId, at, options.wallets);
    const prices = await pricesAt(tx, seasonId, at);
    const payables = await payablesAt(tx, seasonId, at, options.wallets);

    const out = new Map<number, WalletEquity>();
    for (const b of balances) {
      out.set(b.walletId, {
        walletId: b.walletId,
        cash: b.cash,
        reserved: b.reserved,
        positions: [],
        receivable: 0,
        receivableByClub: new Map(),
        buybackClosed,
        equity: 0,
      });
    }
    for (const h of holdings) {
      const wallet = out.get(h.walletId);
      const club = prices.get(h.clubId);
      if (wallet && club) wallet.positions.push({ clubId: h.clubId, ticker: club.ticker, shares: h.shares, price: club.price });
    }
    for (const p of payables) {
      const wallet = out.get(p.walletId);
      if (!wallet) continue;
      wallet.receivable += p.amount;
      wallet.receivableByClub.set(p.clubId, p.amount);
    }
    for (const wallet of out.values()) {
      wallet.equity = engineEquity({ cash: wallet.cash, positions: wallet.positions, receivable: wallet.receivable, buybackClosed });
    }
    return out;
  },
};
