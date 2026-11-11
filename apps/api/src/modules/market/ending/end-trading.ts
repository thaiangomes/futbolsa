import { Injectable, Optional } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { lockClubs, lockSeason, lockWallets, type Tx } from "../../../infra/db/index.js";
import { clubs, orders, seasonClubs, seasons, wallets } from "../../../infra/db/schema/index.js";
import { currentSeason } from "../../admin/current-season.js";
import { instantOf } from "../matching/postgres-matching-engine.js";
import { CancelService } from "../orders/cancel.service.js";
import { MarketEvents } from "../realtime/events.js";
import { dropAuction } from "../state/tunnel-state.js";

export interface EndTradingResult {
  /** `false` quando a negociação já tinha acabado: a segunda chamada não faz nada. */
  ended: boolean;
  seasonId: number;
  /** O `trading_ended_at` gravado (o de antes, quando já tinha acabado). */
  at: Date;
  /** As ordens abertas canceladas com `trading_end`. */
  cancelled: number;
  /** As carteiras que tiveram ordens canceladas, em ordem de id. */
  walletIds: number[];
  /** Os clubes cujo leilão acabou sem negócio (L7), em ordem de ticker. */
  droppedAuctions: string[];
}

export interface EndTradingOptions {
  /** A temporada; sem ela, a atual. */
  seasonId?: number;
}

/**
 * O fim da negociação (Livro de ofertas e formador de mercado, critério 33; T14 e L7 do Plano do livro de ofertas e
 * formador): num instante único para todos os clubes, quando a recompra fecha. Quem chama é a F15, na transação dela
 * (a que grava os eventos de recompra); aqui nada abre transação.
 *
 * 1. trava a temporada (exclusiva). Se a negociação já acabou, não faz nada (idempotente);
 * 2. trava **todos** os clubes, em ordem de ticker: nenhuma ordem, cancelamento, reposição ou fim de leilão anda em
 *    nenhum clube até o `COMMIT`, e depois dele a porta do horário recusa tudo (`market_closed`);
 * 3. o instante gravado é o pedido, nunca antes do último negócio de algum clube (o relógio do jogo não recua, como o
 *    da ordem): nenhum negócio fica com horário depois de `trading_ended_at`;
 * 4. trava numa chamada só as carteiras com ordens abertas e a tesouraria (por último), lidas depois da trava dos
 *    clubes (ordem nova precisa do clube, então a lista não muda mais);
 * 5. cancela todas as ordens abertas, carteira por carteira, com `trading_end`, devolvendo as reservas (o caixa da
 *    compra e as ações da venda voltam ao livre). A casa para de cotar em todos os clubes: as cotações dela também são
 *    ordens abertas;
 * 6. o leilão aberto acaba sem negócio (L7): as colunas do leilão de todos os clubes são limpas sem casar;
 * 7. grava `trading_ended_at` e `status = trading_ended`;
 * 8. depois do `COMMIT`: `season.status`, `order.updated` e `wallet.changed` dos donos, e cada clube marcado para o
 *    livro sair vazio.
 *
 * Depois do fim, a reposição da casa não cota (`market_closed` na porta do horário) e o fim do leilão não acha leilão.
 */
@Injectable()
export class EndTradingService {
  constructor(
    private readonly cancels: CancelService,
    /** Os avisos depois do `COMMIT`. Opcional: sem ele o fim da negociação não avisa ninguém. */
    @Optional() private readonly events?: MarketEvents,
  ) {}

  async endTrading(tx: Tx, at: Date, options: EndTradingOptions = {}): Promise<EndTradingResult> {
    const seasonId = options.seasonId ?? (await currentSeason(tx.db))?.id;
    if (seasonId === undefined) throw new Error("fim da negociação sem temporada atual");

    // 1. A temporada exclusiva: suspensão do mercado todo, abertura do IPO e outro fim da negociação esperam.
    const season = await lockSeason(tx, seasonId, "update");
    const nothing = (when: Date): EndTradingResult => ({ ended: false, seasonId, at: when, cancelled: 0, walletIds: [], droppedAuctions: [] });
    if (season.tradingEndedAt !== null) return nothing(season.tradingEndedAt);
    if (season.status === "trading_ended" || season.status === "closed") return nothing(at);
    if (season.status !== "trading") throw new Error(`a temporada ${seasonId} não está em negociação (${season.status})`);

    // 2 e 3. Todos os clubes, e o instante único do fim.
    const tickers = await this.listedTickers(tx, seasonId);
    const locked = await lockClubs(tx, seasonId, tickers);
    const ended = locked.reduce((instant, club) => instantOf(instant, club.lastTradeAt), at);

    // 4. As carteiras com ordens abertas e a tesouraria, numa trava só.
    const owners = await tx.db
      .selectDistinct({ walletId: orders.walletId })
      .from(orders)
      .where(and(eq(orders.seasonId, seasonId), eq(orders.status, "open")))
      .orderBy(asc(orders.walletId));
    const [treasury] = await tx.db
      .select({ id: wallets.id })
      .from(wallets)
      .where(and(eq(wallets.seasonId, seasonId), eq(wallets.ownerType, "treasury")));
    const walletIds = owners.map((o) => o.walletId);
    await lockWallets(tx, treasury ? [...walletIds, treasury.id] : walletIds);

    // 5. Todas as ordens abertas canceladas, uma carteira por vez, com tudo já travado.
    let cancelled = 0;
    for (const walletId of walletIds) {
      cancelled += (await this.cancels.cancelOrders(tx, walletId, {}, "trading_end", ended)).orders.length;
    }

    // 6. O leilão aberto (ou parado pela suspensão) acaba sem negócio.
    const droppedAuctions: string[] = [];
    for (const club of locked) if (await dropAuction(tx, club)) droppedAuctions.push(club.ticker);

    // 7. O fim gravado: dali em diante a porta do horário recusa as ordens novas com `market_closed`.
    const [row] = await tx.db
      .update(seasons)
      .set({ status: "trading_ended", tradingEndedAt: ended })
      .where(eq(seasons.id, seasonId))
      .returning();

    // 8. Os avisos depois do COMMIT (os das ordens já saíram pelo cancelamento).
    if (this.events) {
      this.events.seasonStatus(tx, row!);
      for (const ticker of tickers) this.events.book.markClubDirty(tx, ticker);
    }
    return { ended: true, seasonId, at: ended, cancelled, walletIds, droppedAuctions };
  }

  private async listedTickers(tx: Tx, seasonId: number): Promise<string[]> {
    const rows = await tx.db
      .select({ ticker: clubs.ticker })
      .from(seasonClubs)
      .innerJoin(clubs, eq(clubs.id, seasonClubs.clubId))
      .where(eq(seasonClubs.seasonId, seasonId));
    // clube listado na temporada sempre tem ticker
    return rows.map((r) => r.ticker!).sort();
  }
}
