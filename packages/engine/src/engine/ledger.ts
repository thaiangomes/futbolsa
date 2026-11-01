import { assertCents, type Cents } from "./money.js";

/**
 * Saldos de dinheiro e ações de cada conta. O que está preso em ordens abertas
 * fica "reservado", e nenhuma operação deixa saldo ou posição negativos, com
 * uma exceção: o estorno de um pagamento corrigido pode deixar o caixa
 * negativo, desde que nada esteja reservado (as compras abertas são
 * canceladas antes; regra do Admin, critério 15).
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

  /**
   * Movimenta dinheiro livre (crédito > 0, débito < 0). O crédito sempre passa,
   * para a venda e o dividendo abaterem um caixa negativo; o débito não deixa o
   * caixa abaixo do reservado.
   */
  adjustCash(id: string, delta: Cents): void {
    assertCents(delta, "movimento de caixa");
    const a = this.get(id);
    if (delta < 0 && a.cash + delta < a.reservedCash) {
      throw new Error(`Saldo insuficiente em ${id}`);
    }
    a.cash += delta;
  }

  /**
   * Estorno de um pagamento corrigido: tira o valor do caixa mesmo que ele fique
   * negativo, desde que não haja caixa reservado. Se o caixa livre não cobre o
   * estorno e há reserva, quem chama cancela antes as ordens de compra da conta.
   */
  reverseCash(id: string, amount: Cents): void {
    assertCents(amount, "estorno");
    if (amount <= 0) throw new Error("Estorno precisa ser positivo");
    const a = this.get(id);
    if (amount > a.cash - a.reservedCash && a.reservedCash > 0) {
      throw new Error(`Estorno maior que o caixa livre de ${id}: cancele as compras abertas antes`);
    }
    a.cash -= amount;
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

/**
 * Invariantes de uma carteira, para os testes e para as restrições do banco:
 * nada reservado negativo, ações reservadas no máximo o total e caixa no
 * mínimo o reservado, exceto o caixa negativo por estorno (aí sem reserva).
 * Devolve a lista do que está quebrado (vazia se tudo certo).
 */
export function walletViolations(a: Pick<Account, "cash" | "reservedCash" | "positions">): string[] {
  const out: string[] = [];
  if (a.reservedCash < 0) out.push("caixa reservado negativo");
  if (a.cash < a.reservedCash && !(a.reservedCash === 0 && a.cash < 0)) out.push("caixa abaixo do reservado");
  for (const [clubId, p] of a.positions) {
    if (p.reserved < 0) out.push(`ações reservadas negativas de ${clubId}`);
    if (p.shares < p.reserved) out.push(`ações reservadas acima do total de ${clubId}`);
  }
  return out;
}
