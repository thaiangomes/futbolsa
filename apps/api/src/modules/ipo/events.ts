import { Injectable } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { entryAddedEventSchema, seasonStatusEventSchema, walletChangedEventSchema } from "@futbolsa/contracts";
import type { Tx } from "../../infra/db/index.js";
import { type seasons, walletEntries } from "../../infra/db/schema/index.js";
import { EventBus, meChannel } from "../../infra/realtime/index.js";
import type { PostResult } from "../portfolio/ledger/post.js";

type SeasonRow = typeof seasons.$inferSelect;

/**
 * Os eventos de tempo real do IPO (F8), sempre depois do `COMMIT` (`tx.afterCommit`): o cliente que reage
 * ao evento lê o banco, e uma transação desfeita não avisa ninguém.
 * - `season.status` (canal `season`): o IPO abriu, fechou ou teve o fechamento adiado;
 * - `wallet.changed` e `entry.added` (canal `me`, só do dono): a cada oferta, edição, cancelamento e na
 *   liquidação, para a tela atualizar o caixa e o extrato sem recarregar. Carteira de bot ou da
 *   tesouraria não tem dono logado: não publica.
 */
@Injectable()
export class IpoEvents {
  constructor(private readonly bus: EventBus) {
    bus.registerSchema("season.status", seasonStatusEventSchema);
    bus.registerSchema("wallet.changed", walletChangedEventSchema);
    bus.registerSchema("entry.added", entryAddedEventSchema);
  }

  /** O estado da temporada como está na linha já gravada (as datas são as novas, no adiamento). */
  seasonStatus(tx: Tx, season: SeasonRow): void {
    const data = {
      seasonId: season.id,
      status: season.status as SeasonRow["status"],
      ipoClosesAt: season.ipoClosesAt?.toISOString() ?? null,
      tradingOpensAt: season.tradingOpensAt?.toISOString() ?? null,
    };
    tx.afterCommit(() => this.bus.publish("season", "season.status", data));
  }

  /**
   * O resultado de um `post` numa carteira de jogador: o caixa e o reservado novos, as ações do clube (quando
   * o movimento tem clube) e a linha do extrato. `ticker` é o do clube do movimento, se houver.
   */
  async posted(tx: Tx, result: PostResult, ticker?: string): Promise<void> {
    const userId = result.wallet.userId;
    if (!userId) return;
    const { entry, wallet, position } = result;
    // A versão é a contagem de linhas do extrato desta carteira (a carteira está travada, então a contagem
    // não anda no meio): o id do extrato é uma sequência do jogo todo e deixaria estimar a atividade dos outros.
    const [{ n: version }] = (await tx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(walletEntries)
      .where(eq(walletEntries.walletId, wallet.id))) as [{ n: number }];
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
