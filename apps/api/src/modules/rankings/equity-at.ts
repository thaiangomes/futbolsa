import type { Cents } from "@futbolsa/engine";
import type { Tx } from "../../infra/db/transaction.js";
import { EquityAt, type HeldPosition } from "../portfolio/valuation/equity-at.js";

/** O que os rankings precisam do patrimônio de uma carteira num instante. */
export interface RankingEquity {
  walletId: number;
  cash: Cents;
  positions: HeldPosition[];
  receivable: Cents;
  equity: Cents;
}

/** Quantas carteiras vão em cada leitura (o limite de parâmetros do Postgres é 65.535; a lista vai dentro do SQL). */
const WALLETS_PER_READ = 20_000;

/**
 * O patrimônio de cada carteira em `at`, pelo histórico (P1 do Plano dos rankings): só adapta o `EquityAt` da carteira
 * (F10), a única implementação da regra. Nenhum SQL de patrimônio mora aqui. Roda no `tx` de quem chama, sem travar
 * nada. Carteira que ainda não existia em `at` não aparece no resultado.
 */
export async function equityAtWallets(tx: Tx, seasonId: number, at: Date, walletIds: readonly number[]): Promise<Map<number, RankingEquity>> {
  const out = new Map<number, RankingEquity>();
  for (let i = 0; i < walletIds.length; i += WALLETS_PER_READ) {
    const part = await EquityAt.forSeason(tx, seasonId, at, { wallets: walletIds.slice(i, i + WALLETS_PER_READ) });
    for (const [id, e] of part) out.set(id, { walletId: id, cash: e.cash, positions: e.positions, receivable: e.receivable, equity: e.equity });
  }
  return out;
}
