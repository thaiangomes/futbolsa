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
  private lastPending: number | null = null;

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

  /** Publica quantos jogos estão pendentes, se mudou desde o último aviso. */
  async publishPending(): Promise<void> {
    const count = (await this.pending.compute()).matches.length;
    if (count === this.lastPending) return;
    this.lastPending = count;
    this.bus.publish("admin", "admin.pending", { pendingMatches: count });
  }
}
