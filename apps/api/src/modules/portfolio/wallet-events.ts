import { Injectable } from "@nestjs/common";
import { and, eq, lte, sql } from "drizzle-orm";
import { entryAddedEventSchema, walletChangedEventSchema } from "@futbolsa/contracts";
import type { Tx } from "../../infra/db/transaction.js";
import { walletEntries } from "../../infra/db/schema/index.js";
import { EventBus, meChannel } from "../../infra/realtime/index.js";
import type { PostResult } from "./ledger/post.js";

/**
 * Os avisos de carteira do canal `me` (`wallet.changed` e `entry.added`), só para o dono, depois do `COMMIT`. É a mesma
 * conta que o IPO usa em `IpoEvents.posted`, no `portfolio` para o `market` publicar sem importar o `ipo`.
 * `version` é a contagem de linhas do extrato **desta carteira** até a linha do evento (a carteira está travada, então a
 * contagem não anda no meio; várias linhas da mesma carteira na mesma transação saem com versões distintas e crescentes): o id do extrato é uma sequência do jogo todo e deixaria estimar a atividade dos outros. Carteira de bot ou da
 * tesouraria não tem dono logado e não publica.
 */
@Injectable()
export class WalletEvents {
  constructor(private readonly bus: EventBus) {
    bus.registerSchema("wallet.changed", walletChangedEventSchema);
    bus.registerSchema("entry.added", entryAddedEventSchema);
  }

  async posted(tx: Tx, result: PostResult, ticker?: string): Promise<void> {
    const userId = result.wallet.userId;
    if (!userId) return;
    const { entry, wallet, position } = result;
    const [{ n: version }] = (await tx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(walletEntries)
      .where(and(eq(walletEntries.walletId, wallet.id), lte(walletEntries.id, entry.id)))) as [{ n: number }];
    const changed = {
      cash: wallet.cash,
      reserved: wallet.reservedCash,
      club: ticker && position ? { ticker, shares: position.shares } : null,
      version,
    };
    const added = {
      version,
      at: entry.at.toISOString(),
      kind: entry.kind,
      ticker: ticker ?? null,
      cashDelta: entry.cashDelta,
      reservedCashDelta: entry.reservedCashDelta,
      sharesDelta: entry.sharesDelta,
      price: entry.price,
      cashAfter: entry.cashAfter,
    };
    tx.afterCommit(() => {
      this.bus.publish(meChannel(userId), "wallet.changed", changed);
      this.bus.publish(meChannel(userId), "entry.added", added);
    });
  }
}
