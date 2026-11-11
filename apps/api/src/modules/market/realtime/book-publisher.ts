import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { clubChannel } from "@futbolsa/contracts";
import { Clock } from "../../../infra/clock/index.js";
import { DB, type Database, type Tx } from "../../../infra/db/index.js";
import { clubs, seasonClubs } from "../../../infra/db/schema/index.js";
import { EventBus } from "../../../infra/realtime/index.js";
import { currentSeason } from "../../admin/current-season.js";
import { readBookLevels } from "../book/book-repo.js";
import { auctionStateOf } from "../state/auction-states.js";
import { changeBp, dayOpenPrice, displayedPriceOf } from "../state/displayed-price.js";

/**
 * Livro e preço no WebSocket por releitura depois do `COMMIT` (P3 do Plano do livro de ofertas e formador). Cada
 * transação que muda o livro de um clube marca o clube como "sujo" no `afterCommit`; um publicador por clube lê do
 * banco o livro de 5 níveis, o preço e a variação e publica `book` (canal do clube) e `price` (canal `prices`), uma
 * leitura por clube de cada vez: se o clube ficou sujo durante a leitura, lê de novo. Assim o último `book` publicado
 * é sempre o do último `COMMIT`, mesmo com os `afterCommit` de duas transações fora de ordem. O barramento já limita
 * `book` a 4 por segundo e `price` a 1 por segundo por clube. Abrir, fechar, parar e recomeçar um leilão só marcam o
 * clube como sujo (P11): o estado do leilão vai dentro do `book` e do `price`.
 */
@Injectable()
export class BookPublisher {
  private readonly logger = new Logger(BookPublisher.name);
  private readonly state = new Map<string, { running: boolean; dirty: boolean; idle: Promise<void> }>();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly bus: EventBus,
    private readonly clock: Clock,
  ) {}

  /** Depois do `COMMIT` de quem mudou o livro, o preço ou o leilão do clube. */
  markClubDirty(tx: Tx, ticker: string): void {
    tx.afterCommit(() => this.mark(ticker));
  }

  /** Marca já (fora de transação): a F14 chama no `afterCommit` da anulação. */
  mark(ticker: string): void {
    let s = this.state.get(ticker);
    if (!s) {
      s = { running: false, dirty: false, idle: Promise.resolve() };
      this.state.set(ticker, s);
    }
    s.dirty = true;
    if (!s.running) {
      s.running = true;
      s.idle = this.flush(ticker, s);
    }
  }

  /** Espera as leituras em andamento terminarem (os testes usam; em produção ninguém espera). */
  async idle(): Promise<void> {
    await Promise.all([...this.state.values()].map((s) => s.idle));
  }

  private async flush(ticker: string, s: { running: boolean; dirty: boolean }): Promise<void> {
    try {
      while (s.dirty) {
        s.dirty = false;
        try {
          await this.publish(ticker);
        } catch (error) {
          this.logger.error(`falha ao publicar o livro de ${ticker}: ${(error as Error).message}`);
        }
      }
    } finally {
      s.running = false;
    }
  }

  private async publish(ticker: string): Promise<void> {
    const season = await currentSeason(this.db);
    if (!season) return;
    const [club] = await this.db
      .select({
        clubId: seasonClubs.clubId,
        lastPrice: seasonClubs.lastPrice,
        ipoPrice: seasonClubs.ipoPrice,
        auctionOpenedAt: seasonClubs.auctionOpenedAt,
        auctionUntil: seasonClubs.auctionUntil,
      })
      .from(seasonClubs)
      .innerJoin(clubs, eq(clubs.id, seasonClubs.clubId))
      .where(and(eq(seasonClubs.seasonId, season.id), eq(clubs.ticker, ticker)));
    if (!club) return;
    const { bids, asks } = await readBookLevels(this.db, club.clubId);
    const price = displayedPriceOf(club);
    const open = await dayOpenPrice(this.db, season.id, ticker, this.clock.now());
    const auction = auctionStateOf(club);
    this.bus.publish(clubChannel(ticker), "book", { bids, asks, auction });
    this.bus.publish("prices", "price", { ticker, price, changeBp: changeBp(price, open), auction });
  }
}
