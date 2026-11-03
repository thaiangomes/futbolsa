import { Injectable } from "@nestjs/common";
import type { Tx } from "../../infra/db/index.js";

/** Por que os compromissos abertos de uma carteira são cancelados. */
export type ClosureReason = "deleted" | "blocked";

/**
 * O que um módulo com compromissos abertos numa carteira (ordens do `market`, ofertas do `ipo`)
 * faz quando a conta é excluída ou bloqueada. Os módulos se registram aqui, e o `accounts` não
 * importa nenhum deles: o `market` também consulta a situação da conta, então a dependência fica
 * num sentido só (decisão do Thaian em 2026-11-01, Plano de login e contas).
 */
export interface ClosureHook {
  /** Tickers dos clubes a travar antes da carteira (os das ordens abertas dela). */
  clubsToLock(tx: Tx, walletId: number): Promise<string[]>;
  /** Cancela o que está aberto e libera as reservas, pelo `portfolio.post`, na transação dada. */
  cancelOpen(tx: Tx, walletId: number, reason: ClosureReason): Promise<void>;
}

/** A lista dos ganchos. A F8 (ofertas) e a F9 (ordens) registram o deles no `onModuleInit`. */
@Injectable()
export class AccountClosureHooks {
  private readonly hooks: ClosureHook[] = [];

  register(hook: ClosureHook): void {
    this.hooks.push(hook);
  }

  async clubsToLock(tx: Tx, walletId: number): Promise<string[]> {
    const all = await Promise.all(this.hooks.map((h) => h.clubsToLock(tx, walletId)));
    return [...new Set(all.flat())];
  }

  /** Em sequência, na ordem de registro: as travas já foram tomadas antes. */
  async cancelOpen(tx: Tx, walletId: number, reason: ClosureReason): Promise<void> {
    for (const hook of this.hooks) await hook.cancelOpen(tx, walletId, reason);
  }
}
