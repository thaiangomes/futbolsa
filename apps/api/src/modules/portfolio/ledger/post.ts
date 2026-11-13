import { and, eq } from "drizzle-orm";
import type { Tx } from "../../../infra/db/transaction.js";
import { positions, walletEntries, wallets } from "../../../infra/db/schema/index.js";
import { applyToPosition, applyToWallet, EMPTY_POSITION, entryValues, validate } from "./apply.js";
import { LedgerError } from "./errors.js";
import type { Movement, OpenWallet } from "./movement.js";

export type WalletRow = typeof wallets.$inferSelect;
export type PositionRow = typeof positions.$inferSelect;
export type WalletEntryRow = typeof walletEntries.$inferSelect;

export interface PostResult {
  entry: WalletEntryRow;
  wallet: WalletRow;
  /** A posição do clube depois do movimento, quando ele tem clube. */
  position?: PositionRow;
}

/**
 * O único caminho de escrita das carteiras (Arquitetura da Fase 1, módulo
 * `portfolio`): aplica o movimento à carteira e à posição do clube e grava a linha do
 * extrato com o caixa depois. A carteira precisa estar travada nesta transação.
 * Vários movimentos da mesma carteira de uma vez: `postMany` (`batch.ts`), com a mesma conta.
 *
 * O caixa só fica negativo por estorno (`reversal`) ou anulação de negócio por trapaça
 * (`trade_annulled`), e então sem nada reservado, porque as compras abertas são canceladas
 * antes (critério 15 do Admin; T25 do Plano do admin de jogadores e bots). Com o caixa
 * negativo, entradas (dividendo, venda) abatem o negativo. Na anulação, o custo e o
 * resultado da posição chegam prontos no movimento (`annulled`, de `replayCost`).
 */
export async function post(tx: Tx, m: Movement): Promise<PostResult> {
  validate(m);
  if (!tx.locks.isWalletLocked(m.walletId)) {
    throw new LedgerError("wallet_not_locked", `carteira ${m.walletId} não está travada nesta transação`);
  }
  const [wallet] = await tx.db.select().from(wallets).where(eq(wallets.id, m.walletId));
  if (!wallet) throw new LedgerError("wallet_not_found", `carteira inexistente: ${m.walletId}`);
  const next = applyToWallet(wallet, m);

  let position: PositionRow | undefined;
  let entryRealized: number | null = null;
  if (m.clubId !== undefined) {
    const [before] = await tx.db
      .select()
      .from(positions)
      .where(and(eq(positions.walletId, m.walletId), eq(positions.clubId, m.clubId)));
    const applied = applyToPosition(before ?? EMPTY_POSITION, m);
    entryRealized = applied.entryRealized;
    const values = applied.position;
    [position] = await tx.db
      .insert(positions)
      .values({ walletId: m.walletId, clubId: m.clubId, ...values })
      .onConflictDoUpdate({ target: [positions.walletId, positions.clubId], set: values })
      .returning();
  }

  const [updated] = await tx.db.update(wallets).set(next).where(eq(wallets.id, m.walletId)).returning();
  const [entry] = await tx.db.insert(walletEntries).values(entryValues(m, next.cash, entryRealized)).returning();
  return { entry: entry!, wallet: updated!, position };
}

/**
 * Abre uma carteira da temporada (de usuário, bot ou a tesouraria) e, com caixa
 * inicial, grava a linha `initial` do extrato. A carteira nova conta como travada.
 */
export async function openWallet(tx: Tx, o: OpenWallet): Promise<WalletRow> {
  const owner = o.owner;
  const [wallet] = await tx.db
    .insert(wallets)
    .values({
      seasonId: o.seasonId,
      ownerType: owner.type,
      userId: owner.type === "user" ? owner.userId : null,
      botId: owner.type === "bot" ? owner.botId : null,
      enteredAt: o.at,
      entryMode: o.entryMode,
    })
    .returning();
  tx.locks.registerNewWallet(wallet!.id, owner.type === "treasury");
  if (o.initialCash) {
    const { wallet: after } = await post(tx, {
      walletId: wallet!.id,
      at: o.at,
      kind: "initial",
      cashDelta: o.initialCash,
    });
    return after;
  }
  return wallet!;
}
