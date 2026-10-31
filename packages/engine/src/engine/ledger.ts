import { assertCents, type Cents } from "./money.js";

/**
 * Saldos de dinheiro e ações de cada conta. O que está preso em ordens abertas
 * fica "reservado", e nenhuma operação deixa saldo ou posição negativos.
 */

export interface Position {
  shares: number;
  /** Ações presas em ordens de venda abertas. */
  reserved: number;
}

export interface Account {
  id: string;
  cash: Cents;
  /** Dinheiro preso em ordens de compra limitadas abertas. */
  reservedCash: Cents;
  positions: Map<string, Position>;
}

export class Ledger {
  private readonly accounts = new Map<string, Account>();

  open(id: string, cash: Cents = 0): Account {
    if (this.accounts.has(id)) throw new Error(`Conta já existe: ${id}`);
    assertCents(cash, "saldo inicial");
    if (cash < 0) throw new Error("Saldo inicial não pode ser negativo");
    const account: Account = { id, cash, reservedCash: 0, positions: new Map() };
    this.accounts.set(id, account);
    return account;
  }

  get(id: string): Account {
    const account = this.accounts.get(id);
    if (!account) throw new Error(`Conta inexistente: ${id}`);
    return account;
  }

  has(id: string): boolean {
    return this.accounts.has(id);
  }

  all(): Account[] {
    return [...this.accounts.values()];
  }

  availableCash(id: string): Cents {
    const a = this.get(id);
    return a.cash - a.reservedCash;
  }

  shares(id: string, clubId: string): number {
    return this.get(id).positions.get(clubId)?.shares ?? 0;
  }

  availableShares(id: string, clubId: string): number {
    const p = this.get(id).positions.get(clubId);
    return p ? p.shares - p.reserved : 0;
  }

  position(id: string, clubId: string): Position {
    const a = this.get(id);
    let p = a.positions.get(clubId);
    if (!p) {
      p = { shares: 0, reserved: 0 };
      a.positions.set(clubId, p);
    }
    return p;
  }

  /** Movimenta dinheiro livre (crédito > 0, débito < 0). */
  adjustCash(id: string, delta: Cents): void {
    assertCents(delta, "movimento de caixa");
    const a = this.get(id);
    if (a.cash + delta < a.reservedCash) {
      throw new Error(`Saldo insuficiente em ${id}`);
    }
    a.cash += delta;
  }

  /** Movimenta ações livres (crédito > 0, débito < 0). */
  adjustShares(id: string, clubId: string, delta: number): void {
    if (!Number.isInteger(delta)) throw new Error("Quantidade de ações deve ser inteira");
    const p = this.position(id, clubId);
    if (p.shares + delta < p.reserved) {
      throw new Error(`Ações insuficientes de ${clubId} em ${id}`);
    }
    p.shares += delta;
  }

  reserveCash(id: string, amount: Cents): void {
    if (amount > this.availableCash(id)) throw new Error(`Saldo insuficiente em ${id}`);
    this.get(id).reservedCash += amount;
  }

  releaseCash(id: string, amount: Cents): void {
    const a = this.get(id);
    if (amount > a.reservedCash) throw new Error("Liberação maior que a reserva");
    a.reservedCash -= amount;
  }

  reserveShares(id: string, clubId: string, quantity: number): void {
    if (quantity > this.availableShares(id, clubId)) {
      throw new Error(`Ações insuficientes de ${clubId} em ${id}`);
    }
    this.position(id, clubId).reserved += quantity;
  }

  releaseShares(id: string, clubId: string, quantity: number): void {
    const p = this.position(id, clubId);
    if (quantity > p.reserved) throw new Error("Liberação maior que a reserva");
    p.reserved -= quantity;
  }

  /** Total de ações de um clube em todas as contas (inclusive tesouraria). */
  totalShares(clubId: string): number {
    let total = 0;
    for (const a of this.accounts.values()) total += a.positions.get(clubId)?.shares ?? 0;
    return total;
  }

  totalCash(): Cents {
    let total = 0;
    for (const a of this.accounts.values()) total += a.cash;
    return total;
  }
}
