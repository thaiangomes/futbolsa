import { and, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "../../../infra/db/transaction.js";
import { positions, walletEntries, wallets } from "../../../infra/db/schema/index.js";
import { applyToPosition, applyToWallet, EMPTY_POSITION, entryValues, validate, type PositionState, type WalletState } from "./apply.js";
import { LedgerError } from "./errors.js";
import type { Movement } from "./movement.js";
import type { PositionRow, PostResult, WalletEntryRow, WalletRow } from "./post.js";

export interface PostManyResult {
  /** Um por movimento, na ordem: o que o `post` daquele movimento devolveria num laço. */
  results: PostResult[];
  /** As linhas do extrato, na ordem dos movimentos (os ids crescem nessa ordem). */
  entries: WalletEntryRow[];
  /** A carteira depois do último movimento (sem movimentos, nada foi lido: `undefined`). */
  wallet?: WalletRow;
  /** A posição final de cada clube que algum movimento tocou, por id do clube. */
  positions: Map<number, PositionRow>;
}

/** Linhas do extrato por `INSERT` (14 colunas cada, bem abaixo do limite de 65.535 parâmetros do Postgres). */
const ENTRIES_PER_INSERT = 2000;

const excluded = (column: string) => sql.raw(`excluded."${column}"`);

/**
 * Vários movimentos da mesma carteira de uma vez, com o resultado de um laço de `post`: a mesma
 * conta (`apply.ts`), as mesmas recusas, na mesma ordem, conferidas movimento a movimento (o caixa
 * não pode ficar negativo no meio do lote, mesmo que o fim cubra). Tudo é conferido na memória
 * antes de escrever; depois são poucos comandos, quantos forem os movimentos: lê a carteira, lê
 * as posições dos clubes tocados, grava as posições finais (um `INSERT … ON CONFLICT DO UPDATE`),
 * a carteira (um `UPDATE`) e o extrato (um `INSERT` com todas as linhas, cada uma com o caixa
 * depois dela). A carteira precisa estar travada nesta transação. Sem movimentos, não faz nada.
 */
export async function postMany(tx: Tx, movements: readonly Movement[]): Promise<PostManyResult> {
  if (movements.length === 0) return { results: [], entries: [], positions: new Map() };
  const walletId = movements[0]!.walletId;
  const other = movements.find((m) => m.walletId !== walletId);
  if (other) {
    throw new LedgerError("wallet_mismatch", `postMany com carteiras diferentes: ${walletId} e ${other.walletId}`);
  }

  validate(movements[0]!);
  if (!tx.locks.isWalletLocked(walletId)) {
    throw new LedgerError("wallet_not_locked", `carteira ${walletId} não está travada nesta transação`);
  }
  const [wallet] = await tx.db.select().from(wallets).where(eq(wallets.id, walletId));
  if (!wallet) throw new LedgerError("wallet_not_found", `carteira inexistente: ${walletId}`);

  const clubIds = [...new Set(movements.flatMap((m) => (m.clubId === undefined ? [] : [m.clubId])))];
  const current = new Map<number, PositionState>();
  if (clubIds.length > 0) {
    const rows = await tx.db
      .select()
      .from(positions)
      .where(and(eq(positions.walletId, walletId), inArray(positions.clubId, clubIds)));
    for (const row of rows) current.set(row.clubId, row);
  }

  // a conta inteira na memória, movimento a movimento, antes de qualquer escrita
  let state: WalletState = { cash: wallet.cash, reservedCash: wallet.reservedCash, openOrders: wallet.openOrders };
  const steps = movements.map((m, i) => {
    if (i > 0) validate(m);
    state = applyToWallet(state, m);
    let position: PositionState | undefined;
    let realized: number | null = null;
    if (m.clubId !== undefined) {
      const applied = applyToPosition(current.get(m.clubId) ?? EMPTY_POSITION, m);
      position = applied.position;
      realized = applied.entryRealized;
      current.set(m.clubId, position);
    }
    return { wallet: state, position, entry: entryValues(m, state.cash, realized) };
  });

  const finalPositions = new Map<number, PositionRow>();
  if (clubIds.length > 0) {
    const rows = await tx.db
      .insert(positions)
      .values(
        clubIds.map((clubId) => {
          const p = current.get(clubId)!;
          return { walletId, clubId, shares: p.shares, reservedShares: p.reservedShares, cost: p.cost, realized: p.realized, dividends: p.dividends };
        }),
      )
      .onConflictDoUpdate({
        target: [positions.walletId, positions.clubId],
        set: {
          shares: excluded(positions.shares.name),
          reservedShares: excluded(positions.reservedShares.name),
          cost: excluded(positions.cost.name),
          realized: excluded(positions.realized.name),
          dividends: excluded(positions.dividends.name),
        },
      })
      .returning();
    for (const row of rows) finalPositions.set(row.clubId, row);
  }

  const [updated] = await tx.db
    .update(wallets)
    .set({ cash: state.cash, reservedCash: state.reservedCash, openOrders: state.openOrders })
    .where(eq(wallets.id, walletId))
    .returning();

  const entries: WalletEntryRow[] = [];
  for (let start = 0; start < steps.length; start += ENTRIES_PER_INSERT) {
    const rows = await tx.db
      .insert(walletEntries)
      .values(steps.slice(start, start + ENTRIES_PER_INSERT).map((s) => s.entry))
      .returning();
    // os ids saem da sequência na ordem das linhas do VALUES; o extrato é lido por id
    entries.push(...rows.sort((a, b) => a.id - b.id));
  }

  const results = steps.map(
    (s, i): PostResult => ({
      entry: entries[i]!,
      wallet: { ...updated!, ...s.wallet },
      position: s.position && { walletId, clubId: movements[i]!.clubId!, ...s.position },
    }),
  );
  return { results, entries, wallet: updated!, positions: finalPositions };
}
