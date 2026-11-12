import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { type PayoutCreditedEvent, payoutCreditedEventSchema } from "@futbolsa/contracts";
import { DB, type Database } from "../../../infra/db/index.js";
import { payoutEvents, wallets } from "../../../infra/db/schema/index.js";
import { EventBus, meChannel } from "../../../infra/realtime/index.js";
import { AdminEvents } from "../events.js";
import { currentSeason } from "../current-season.js";
import type { CreditedBatch } from "./settle-credits.js";

/**
 * Os avisos de tempo real dos pagamentos, sempre depois do `COMMIT` (T9): `payout.credited` no canal `me` de cada dono
 * que recebeu ou devolveu, e `admin.pending` no canal `admin` com quantos pagamentos aguardam aprovação. Falha daqui
 * nunca desfaz dinheiro: só vai para o log.
 */
@Injectable()
export class PayoutEvents implements OnModuleInit {
  private readonly logger = new Logger("Pagamentos");

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly bus: EventBus,
    private readonly adminEvents: AdminEvents,
  ) {
    bus.registerSchema("payout.credited", payoutCreditedEventSchema);
  }

  onModuleInit(): void {
    this.adminEvents.registerPayoutsCounter(async () => {
      const season = await currentSeason(this.db);
      if (!season) return 0;
      const [row] = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(payoutEvents)
        .where(and(eq(payoutEvents.seasonId, season.id), eq(payoutEvents.status, "pending")));
      return row?.n ?? 0;
    });
  }

  /** Um lote creditou: o `payout.credited` de cada dono (bots e tesouraria não têm canal `me`) e o número do admin. */
  async credited(batch: CreditedBatch): Promise<void> {
    try {
      const ids = [...new Set(batch.credits.map((c) => c.walletId))];
      const owners = new Map(
        (await this.db.select({ id: wallets.id, userId: wallets.userId }).from(wallets).where(inArray(wallets.id, ids))).map((w) => [w.id, w.userId]),
      );
      const { rows } = await this.db.execute(sql`select coalesce(ticker, 'EXT-' || id::text) as ticker from futbolsa.clubs where id = ${batch.clubId}`);
      const ticker = String(rows[0]?.ticker ?? "");
      for (const credit of batch.credits) {
        const userId = owners.get(credit.walletId);
        if (!userId) continue;
        const data: PayoutCreditedEvent = { eventId: batch.eventId, kind: credit.kind, ticker, reason: batch.reason, amount: credit.amount };
        this.bus.publish(meChannel(userId), "payout.credited", data);
      }
    } catch (error) {
      this.logger.error(`aviso payout.credited do evento ${batch.eventId} falhou: ${(error as Error).message}`);
    }
  }

  /** Eventos nasceram, mudaram, foram aprovados ou corrigidos: o admin vê o número novo sem recarregar. */
  async adminChanged(): Promise<void> {
    try {
      await this.adminEvents.publishPending();
    } catch (error) {
      this.logger.error(`aviso admin.pending falhou: ${(error as Error).message}`);
    }
  }
}
