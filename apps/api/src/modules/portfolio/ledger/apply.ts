import type { Cents } from "@futbolsa/engine";
import type { walletEntries, WalletEntryKind } from "../../../infra/db/schema/index.js";
import { applyCost } from "./cost.js";
import { LedgerError } from "./errors.js";
import type { Movement } from "./movement.js";

/**
 * A conta de um movimento, sem banco: a regra que o `post` (um movimento) e o `postMany` (vários
 * da mesma carteira) aplicam igual, na mesma ordem, com as mesmas recusas.
 */

/** Somam (ou tiram) em `positions.dividends`. */
export const DIVIDEND_KINDS: ReadonlySet<WalletEntryKind> = new Set(["dividend", "reversal", "complement"]);
/** Movimentos do admin, que sempre levam o motivo. */
export const REASON_KINDS: ReadonlySet<WalletEntryKind> = new Set(["adjustment", "reversal", "complement", "trade_annulled"]);
/**
 * Podem deixar o caixa negativo, e então sem nada reservado: o estorno (critério 15 do Admin) e a anulação de
 * negócio por trapaça, em que quem vendeu devolve o dinheiro mesmo que já o tenha gastado (T25).
 */
export const NEGATIVE_CASH_KINDS: ReadonlySet<WalletEntryKind> = new Set(["reversal", "trade_annulled"]);
/**
 * O `ref_type` da linha `trade_annulled`: o negócio desfeito, o mesmo `TRADE_REF` das linhas `trade` do
 * `market` (`matching/settle.ts`), repetido aqui para o `portfolio` não depender do `market`.
 */
export const ANNULLED_REF_TYPE = "trade";

/** O que o movimento confere sozinho, antes de olhar a carteira. */
export function validate(m: Movement): void {
  for (const [label, value] of [
    ["cashDelta", m.cashDelta],
    ["reservedCashDelta", m.reservedCashDelta],
    ["price", m.price],
    ["annulled.cost", m.annulled?.cost],
    ["annulled.realized", m.annulled?.realized],
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
  const annulment = m.kind === "trade_annulled";
  const touchesShares = (m.sharesDelta ?? 0) !== 0 || (m.reservedSharesDelta ?? 0) !== 0;
  if (m.clubId === undefined && (touchesShares || DIVIDEND_KINDS.has(m.kind) || m.costBasis || annulment)) {
    throw new LedgerError("club_required", `movimento ${m.kind} sem clube`);
  }
  if (annulment) {
    // o custo vem pronto: a origem do custo não se aplica, e o preço (do negócio) é só para o extrato
    if (!m.annulled) throw new LedgerError("annulled_required", "anulação de negócio sem o custo e o resultado refeitos");
    if (m.annulled.cost < 0) throw new LedgerError("invalid_cents", `annulled.cost não pode ser negativo, recebido ${m.annulled.cost}`);
    if (m.costBasis) throw new LedgerError("cost_basis_mismatch", `a anulação de negócio não leva origem do custo, recebido ${m.costBasis}`);
    if (m.ref?.type !== ANNULLED_REF_TYPE || !String(m.ref.id).trim()) {
      throw new LedgerError("trade_ref_required", "anulação de negócio sem o negócio no ref");
    }
  } else if (m.annulled) {
    throw new LedgerError("annulled_not_allowed", `movimento ${m.kind} com custo pronto: só a anulação de negócio o aceita`);
  }
  if ((m.sharesDelta ?? 0) !== 0 && !m.costBasis && !annulment) {
    throw new LedgerError("cost_basis_required", `movimento ${m.kind} mexe em ações sem dizer a origem do custo`);
  }
  // a recompra de clube que não pagou nada é a venda à casa por R$ 0,00 (Dividendos e recompra, critério 24)
  const freeBuyback = m.kind === "buyback" && m.costBasis === "sale" && m.price === 0;
  if ((m.costBasis === "purchase" || m.costBasis === "sale") && !(m.price && m.price > 0) && !freeBuyback) {
    throw new LedgerError("price_required", `movimento ${m.kind} (${m.costBasis}) sem preço`);
  }
  if (REASON_KINDS.has(m.kind) && !m.reason?.trim()) {
    throw new LedgerError("reason_required", `movimento ${m.kind} sem motivo`);
  }
}

export interface WalletState {
  cash: Cents;
  reservedCash: Cents;
  openOrders: number;
}

/**
 * O caixa, o reservado e as ordens abertas depois do movimento. O caixa só fica negativo por
 * estorno (`reversal`) ou anulação de negócio (`trade_annulled`), e então sem nada reservado; com o
 * caixa negativo, entradas abatem o negativo.
 */
export function applyToWallet(wallet: WalletState, m: Movement): WalletState {
  const cashDelta = m.cashDelta ?? 0;
  const cash = wallet.cash + cashDelta;
  const reservedCash = wallet.reservedCash + (m.reservedCashDelta ?? 0);
  const openOrders = wallet.openOrders + (m.openOrdersDelta ?? 0);
  if (reservedCash < 0) throw new LedgerError("negative_reserved_cash", "caixa reservado negativo");
  if (cash < 0) {
    if (!NEGATIVE_CASH_KINDS.has(m.kind) && cashDelta < 0) {
      throw new LedgerError("negative_cash", `o movimento ${m.kind} deixaria o caixa negativo`);
    }
    if (reservedCash !== 0) {
      throw new LedgerError("reserved_exceeds_cash", "caixa negativo com caixa reservado: cancele as compras antes");
    }
  } else if (reservedCash > cash) {
    throw new LedgerError("reserved_exceeds_cash", "caixa reservado acima do caixa");
  }
  if (openOrders < 0) throw new LedgerError("negative_open_orders", "ordens abertas negativas");
  return { cash, reservedCash, openOrders };
}

export interface PositionState {
  shares: number;
  reservedShares: number;
  cost: Cents;
  realized: Cents;
  dividends: Cents;
}

/** A posição de um clube que a carteira ainda não tem. */
export const EMPTY_POSITION: Readonly<PositionState> = { shares: 0, reservedShares: 0, cost: 0, realized: 0, dividends: 0 };

/** A posição do clube depois do movimento e o resultado realizado dele (para a linha do extrato). */
export function applyToPosition(current: PositionState, m: Movement): { position: PositionState; entryRealized: Cents | null } {
  const shares = current.shares + (m.sharesDelta ?? 0);
  const reservedShares = current.reservedShares + (m.reservedSharesDelta ?? 0);
  if (shares < 0) throw new LedgerError("negative_shares", "posição negativa");
  if (reservedShares < 0) throw new LedgerError("negative_reserved_shares", "ações reservadas negativas");
  if (reservedShares > shares) throw new LedgerError("reserved_exceeds_shares", "ações reservadas acima das ações");
  const costChange = applyCost(current, m);
  return {
    position: {
      shares,
      reservedShares,
      cost: costChange.cost,
      realized: costChange.realized,
      dividends: current.dividends + (DIVIDEND_KINDS.has(m.kind) ? (m.cashDelta ?? 0) : 0),
    },
    entryRealized: costChange.entryRealized,
  };
}

/** A linha do extrato do movimento, com o caixa depois. */
export function entryValues(m: Movement, cashAfter: Cents, realized: Cents | null): typeof walletEntries.$inferInsert {
  return {
    walletId: m.walletId,
    at: m.at,
    kind: m.kind,
    clubId: m.clubId,
    cashDelta: m.cashDelta ?? 0,
    reservedCashDelta: m.reservedCashDelta ?? 0,
    sharesDelta: m.sharesDelta ?? 0,
    reservedSharesDelta: m.reservedSharesDelta ?? 0,
    price: m.price,
    realized,
    cashAfter,
    refType: m.ref?.type,
    refId: m.ref === undefined ? undefined : String(m.ref.id),
    reason: m.reason,
  };
}
