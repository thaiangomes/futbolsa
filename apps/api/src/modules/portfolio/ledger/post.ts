import { and, eq } from "drizzle-orm";
import type { Tx } from "../../../infra/db/transaction.js";
import { positions, walletEntries, wallets, type WalletEntryKind } from "../../../infra/db/schema/index.js";
import { applyCost } from "./cost.js";
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

/** Somam (ou tiram) em `positions.dividends`. */
const DIVIDEND_KINDS: ReadonlySet<WalletEntryKind> = new Set(["dividend", "reversal", "complement"]);
/** Movimentos do admin, que sempre levam o motivo. */
const REASON_KINDS: ReadonlySet<WalletEntryKind> = new Set(["adjustment", "reversal", "complement"]);

function validate(m: Movement): void {
  for (const [label, value] of [
    ["cashDelta", m.cashDelta],
    ["reservedCashDelta", m.reservedCashDelta],
    ["price", m.price],
  ] as const) {
    if (value !== undefined && !Number.isSafeInteger(value)) {
      throw new LedgerError("invalid_cents", `${label} deve ser um inteiro em centavos, recebido ${value}`);
    }
  }
  for (const [label, value] of [
    ["sharesDelta", m.sharesDelta],
    ["reservedSharesDelta", m.reservedSharesDelta],
    ["openOrdersDelta", m.openOrdersDelta],
  ] as const) {
    if (value !== undefined && !Number.isSafeInteger(value)) {
      throw new LedgerError("invalid_quantity", `${label} deve ser inteiro, recebido ${value}`);
    }
  }
  const touchesShares = (m.sharesDelta ?? 0) !== 0 || (m.reservedSharesDelta ?? 0) !== 0;
  if (m.clubId === undefined && (touchesShares || DIVIDEND_KINDS.has(m.kind) || m.costBasis)) {
    throw new LedgerError("club_required", `movimento ${m.kind} sem clube`);
  }
  if ((m.sharesDelta ?? 0) !== 0 && !m.costBasis) {
    throw new LedgerError("cost_basis_required", `movimento ${m.kind} mexe em ações sem dizer a origem do custo`);
  }
  if ((m.costBasis === "purchase" || m.costBasis === "sale") && !(m.price && m.price > 0)) {
    throw new LedgerError("price_required", `movimento ${m.kind} (${m.costBasis}) sem preço`);
  }
  if (REASON_KINDS.has(m.kind) && !m.reason?.trim()) {
    throw new LedgerError("reason_required", `movimento ${m.kind} sem motivo`);
  }
}

/**
 * O único caminho de escrita das carteiras (Arquitetura da Fase 1, módulo
 * `portfolio`): aplica o movimento à carteira e à posição do clube e grava a linha do
 * extrato com o caixa depois. A carteira precisa estar travada nesta transação.
 *
 * O caixa só fica negativo por estorno (`reversal`), e então sem nada reservado,
 * porque as compras abertas são canceladas antes (critério 15 do Admin). Com o
 * caixa negativo, entradas (dividendo, venda) abatem o negativo.
 */
export async function post(tx: Tx, m: Movement): Promise<PostResult> {
  validate(m);
  if (!tx.locks.isWalletLocked(m.walletId)) {
    throw new LedgerError("wallet_not_locked", `carteira ${m.walletId} não está travada nesta transação`);
  }
  const [wallet] = await tx.db.select().from(wallets).where(eq(wallets.id, m.walletId));
  if (!wallet) throw new LedgerError("wallet_not_found", `carteira inexistente: ${m.walletId}`);

  const cashDelta = m.cashDelta ?? 0;
  const cash = wallet.cash + cashDelta;
  const reservedCash = wallet.reservedCash + (m.reservedCashDelta ?? 0);
  const openOrders = wallet.openOrders + (m.openOrdersDelta ?? 0);
  if (reservedCash < 0) throw new LedgerError("negative_reserved_cash", "caixa reservado negativo");
  if (cash < 0) {
    if (m.kind !== "reversal" && cashDelta < 0) {
      throw new LedgerError("negative_cash", `o movimento ${m.kind} deixaria o caixa negativo`);
    }
    if (reservedCash !== 0) {
      throw new LedgerError("reserved_exceeds_cash", "caixa negativo com caixa reservado: cancele as compras antes");
    }
  } else if (reservedCash > cash) {
    throw new LedgerError("reserved_exceeds_cash", "caixa reservado acima do caixa");
  }
  if (openOrders < 0) throw new LedgerError("negative_open_orders", "ordens abertas negativas");

  let position: PositionRow | undefined;
  let entryRealized: number | null = null;
  if (m.clubId !== undefined) {
    const [before] = await tx.db
      .select()
      .from(positions)
      .where(and(eq(positions.walletId, m.walletId), eq(positions.clubId, m.clubId)));
    const current = before ?? { shares: 0, reservedShares: 0, cost: 0, realized: 0, dividends: 0 };
    const shares = current.shares + (m.sharesDelta ?? 0);
    const reservedShares = current.reservedShares + (m.reservedSharesDelta ?? 0);
    if (shares < 0) throw new LedgerError("negative_shares", "posição negativa");
    if (reservedShares < 0) throw new LedgerError("negative_reserved_shares", "ações reservadas negativas");
    if (reservedShares > shares) throw new LedgerError("reserved_exceeds_shares", "ações reservadas acima das ações");
    const costChange = applyCost(current, m);
    entryRealized = costChange.entryRealized;
    const values = {
      shares,
      reservedShares,
      cost: costChange.cost,
      realized: costChange.realized,
      dividends: current.dividends + (DIVIDEND_KINDS.has(m.kind) ? cashDelta : 0),
    };
    [position] = await tx.db
      .insert(positions)
      .values({ walletId: m.walletId, clubId: m.clubId, ...values })
      .onConflictDoUpdate({ target: [positions.walletId, positions.clubId], set: values })
      .returning();
  }

  const [updated] = await tx.db
    .update(wallets)
    .set({ cash, reservedCash, openOrders })
    .where(eq(wallets.id, m.walletId))
    .returning();
  const [entry] = await tx.db
    .insert(walletEntries)
    .values({
      walletId: m.walletId,
      at: m.at,
      kind: m.kind,
      clubId: m.clubId,
      cashDelta,
      reservedCashDelta: m.reservedCashDelta ?? 0,
      sharesDelta: m.sharesDelta ?? 0,
      reservedSharesDelta: m.reservedSharesDelta ?? 0,
      price: m.price,
      realized: entryRealized,
      cashAfter: cash,
      refType: m.ref?.type,
      refId: m.ref === undefined ? undefined : String(m.ref.id),
      reason: m.reason,
    })
    .returning();
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
