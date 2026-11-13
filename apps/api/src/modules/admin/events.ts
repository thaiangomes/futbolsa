import { Injectable } from "@nestjs/common";
import {
  adminPendingEventSchema,
  type MarketResumedEvent,
  marketResumedEventSchema,
  type MarketSuspendedEvent,
  marketSuspendedEventSchema,
} from "@futbolsa/contracts";
import type { Tx } from "../../infra/db/index.js";
import { EventBus } from "../../infra/realtime/index.js";
import { PendingService } from "./results/pending.service.js";
import { MatchesEvents } from "./results/ports.js";

/**
 * Os eventos de tempo real do admin, sempre depois do `COMMIT` (nunca antes: o cliente que reage ao evento
 * lê o banco): `market.suspended` e `market.resumed` no canal `season` (o aviso a todos os jogadores) e
 * `admin.pending` no canal `admin` (a tela do admin mostra a pendência sem recarregar).
 */
@Injectable()
export class AdminEvents {
  private lastPending: string | null = null;
  private payoutsCounter: (() => Promise<number>) | null = null;
  private fraudCounter: (() => Promise<number>) | null = null;

  constructor(
    private readonly bus: EventBus,
    private readonly pending: PendingService,
    matchesEvents: MatchesEvents,
  ) {
    bus.registerSchema("market.suspended", marketSuspendedEventSchema);
    bus.registerSchema("market.resumed", marketResumedEventSchema);
    bus.registerSchema("admin.pending", adminPendingEventSchema);
    // Jogo importado, preenchido ou corrigido pode criar ou resolver pendência.
    matchesEvents.subscribe(() => this.publishPending());
  }

  marketSuspended(tx: Tx, data: MarketSuspendedEvent): void {
    tx.afterCommit(() => this.bus.publish("season", "market.suspended", data));
  }

  marketResumed(tx: Tx, data: MarketResumedEvent): void {
    tx.afterCommit(() => this.bus.publish("season", "market.resumed", data));
  }

  /** A F12 registra quem conta os pagamentos aguardando (o `admin` não importa a pasta `payouts`). */
  registerPayoutsCounter(counter: () => Promise<number>): void {
    this.payoutsCounter = counter;
  }

  /** A trapaça (F14) registra quem conta os casos abertos. */
  registerFraudCounter(counter: () => Promise<number>): void {
    this.fraudCounter = counter;
  }

  /** Publica quantos jogos e pagamentos estão pendentes, se algum número mudou desde o último aviso. */
  async publishPending(): Promise<void> {
    const pendingMatches = (await this.pending.compute()).matches.length;
    const pendingPayouts = this.payoutsCounter ? await this.payoutsCounter() : undefined;
    const openFraudCases = this.fraudCounter ? await this.fraudCounter() : undefined;
    const key = `${pendingMatches}/${pendingPayouts ?? ""}/${openFraudCases ?? ""}`;
    if (key === this.lastPending) return;
    this.lastPending = key;
    this.bus.publish("admin", "admin.pending", {
      pendingMatches,
      ...(pendingPayouts === undefined ? {} : { pendingPayouts }),
      ...(openFraudCases === undefined ? {} : { openFraudCases }),
    });
  }
}
