import { Inject, Injectable, Logger } from "@nestjs/common";
import { Clock } from "../../infra/clock/index.js";
import { DB, type Database, withTransaction } from "../../infra/db/index.js";
import type { Tx } from "../../infra/db/transaction.js";
import { RankingsPort, type PayoutsChange } from "../admin/payouts/ports.js";
import { pendingRecalc, processOneRecalc, requestRecalc } from "./recalc.js";

/** O recálculo dos rankings já fechados (T6): o pedido gravado na transação de quem mudou o pagamento e o atendimento. */
@Injectable()
export class RecalcService {
  private readonly logger = new Logger("Rankings");
  private running = false;

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  requestRecalc(tx: Tx, args: { seasonId: number; from: Date; reason: string }): Promise<void> {
    return requestRecalc(tx, { ...args, now: this.clock.now() });
  }

  pendingRecalc(tx: Pick<Tx, "db">, seasonId: number): Promise<boolean> {
    return pendingRecalc(tx, seasonId);
  }

  /**
   * Atende todos os pedidos abertos, um por transação (`repeatable read`: uma foto só do histórico). Não trava carteira
   * nem clube. Devolve o que foi refeito.
   */
  async processRecalcRequests(now: Date = this.clock.now()): Promise<Array<{ seasonId: number; versions: string[] }>> {
    if (this.running) return [];
    this.running = true;
    try {
      const out: Array<{ seasonId: number; versions: string[] }> = [];
      for (;;) {
        const done = await withTransaction(this.db, (tx) => processOneRecalc(tx, now), { isolationLevel: "repeatable read" });
        if (!done) break;
        out.push(done);
      }
      return out;
    } finally {
      this.running = false;
    }
  }

  /** Acorda o atendimento depois do `COMMIT` de quem pediu, sem segurar a resposta dele. */
  wake(): void {
    void this.processRecalcRequests().catch((error: unknown) => this.logger.error(`recálculo falhou: ${(error as Error).message}`));
  }
}

/** A F12 chama esta porta dentro da transação do pagamento e acorda o atendimento depois do `COMMIT` (P3). */
@Injectable()
export class RankingsPortAdapter extends RankingsPort {
  constructor(private readonly recalc: RecalcService) {
    super();
  }

  async payoutsChanged(tx: Tx, change: PayoutsChange): Promise<void> {
    if (change.closedAts.length === 0) return;
    const from = new Date(Math.min(...change.closedAts.map((d) => d.getTime())));
    await this.recalc.requestRecalc(tx, { seasonId: change.seasonId, from, reason: "pagamento" });
  }

  async wake(): Promise<void> {
    this.recalc.wake();
  }
}
