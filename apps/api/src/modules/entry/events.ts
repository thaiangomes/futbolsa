import { Injectable } from "@nestjs/common";
import type { Tx } from "../../infra/db/index.js";
import { EventBus, meChannel } from "../../infra/realtime/index.js";
import type { PostResult } from "../portfolio/ledger/index.js";

/**
 * Os avisos do canal `me` de quem acabou de entrar (`wallet.changed` e `entry.added`), publicados só depois do
 * `COMMIT`. Não passa pelo `WalletEvents.posted`: ele conta as linhas do extrato a cada aviso (uma leitura por clube),
 * e a entrada está com todos os clubes travados. A carteira é nova, então a versão é a posição da linha no extrato:
 * a linha `initial` é a 1 e as `index_entry` seguem em ordem. Preço e livro não mudam, então nada vai ao canal público.
 */
@Injectable()
export class EntryEvents {
  constructor(private readonly bus: EventBus) {}

  entered(
    tx: Tx,
    userId: string,
    entry: { initialCash: number; at: Date; posted: { result: PostResult; ticker: string }[] },
  ): void {
    const channel = meChannel(userId);
    const at = entry.at.toISOString();
    tx.afterCommit(() => {
      this.bus.publish(channel, "wallet.changed", { cash: entry.initialCash, reserved: 0, club: null, version: 1 });
      this.bus.publish(channel, "entry.added", {
        version: 1,
        at,
        kind: "initial",
        ticker: null,
        cashDelta: entry.initialCash,
        reservedCashDelta: 0,
        sharesDelta: 0,
        price: null,
        cashAfter: entry.initialCash,
      });
      entry.posted.forEach(({ result, ticker }, i) => {
        const version = i + 2;
        const row = result.entry;
        this.bus.publish(channel, "wallet.changed", {
          cash: result.wallet.cash,
          reserved: result.wallet.reservedCash,
          club: result.position ? { ticker, shares: result.position.shares } : null,
          version,
        });
        this.bus.publish(channel, "entry.added", {
          version,
          at,
          kind: row.kind,
          ticker,
          cashDelta: row.cashDelta,
          reservedCashDelta: row.reservedCashDelta,
          sharesDelta: row.sharesDelta,
          price: row.price,
          cashAfter: row.cashAfter,
        });
      });
    });
  }
}
