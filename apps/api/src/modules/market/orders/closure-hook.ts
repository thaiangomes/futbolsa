import { Injectable } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import type { Tx } from "../../../infra/db/index.js";
import { clubs, orders } from "../../../infra/db/schema/index.js";
import type { ClosureHook, ClosureReason } from "../../accounts/index.js";
import { CancelService } from "./cancel.service.js";
import { listedTicker } from "./views.js";

/**
 * O que o mercado faz quando uma conta é excluída (F5) ou bloqueada (F14): o gancho de encerramento que o
 * `MarketModule` registra no `AccountClosureHooks` (proposta 5 do Plano de login e contas). O `accounts` não importa o
 * mercado; o mercado se registra nele.
 *
 * - `clubsToLock`: os clubes das ordens abertas da carteira, lidos sem trava. Quem encerra trava esses clubes antes da
 *   carteira, na ordem do jogo.
 * - `cancelOpen`: cancela todas as ordens abertas da carteira com o motivo (`deleted` ou `blocked`) e devolve as
 *   reservas, pelo `cancelOrders`. Se uma ordem nova entrou noutro clube entre a leitura dos clubes e a trava da
 *   carteira, o `cancelOrders` pede a repetição da transação inteira (`ClubsNotLockedError`).
 */
@Injectable()
export class MarketClosureHook implements ClosureHook {
  constructor(private readonly cancels: CancelService) {}

  async clubsToLock(tx: Tx, walletId: number): Promise<string[]> {
    const rows = await tx.db
      .selectDistinct({ ticker: listedTicker })
      .from(orders)
      .innerJoin(clubs, eq(clubs.id, orders.clubId))
      .where(and(eq(orders.walletId, walletId), eq(orders.status, "open")))
      .orderBy(asc(clubs.ticker));
    return rows.map((r) => r.ticker);
  }

  async cancelOpen(tx: Tx, walletId: number, reason: ClosureReason, at: Date): Promise<void> {
    await this.cancels.cancelOrders(tx, walletId, {}, reason, at);
  }
}
