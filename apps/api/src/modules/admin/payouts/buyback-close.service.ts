import { Inject, Injectable, Logger, type OnModuleInit, Optional } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { buybackCloseTime } from "@futbolsa/engine";
import { Clock } from "../../../infra/clock/index.js";
import { DB, type Database, lockClubs, lockSeason, lockWallets, type Tx, withTransaction } from "../../../infra/db/index.js";
import { clubs, orders, payoutEvents, seasonClubs, seasons, wallets } from "../../../infra/db/schema/index.js";
import { EndTradingService } from "../../market/index.js";
import { BUYBACK_EVENTS, buybackEventsOf } from "./buyback-events.js";
import { CLOSE_MARGIN_MS, CloseEventsService, eventsResultOf, roundAndPhase, storedCompetition } from "./close-events.service.js";
import { EngineInputService, type SeasonEngineInput } from "./engine-input.js";
import { PayoutEvents } from "./events.js";
import { holdingsAt, writeHoldings } from "./holdings.js";
import { RankingsPort } from "./ports.js";

/** O que o fechamento da recompra fez. */
export interface BuybackCloseResult {
  seasonId: number;
  /** D: o `trading_ended_at` gravado, o instante da foto e o `closed_at` dos eventos de recompra. */
  at: Date;
  /** Eventos de recompra gravados (um por clube listado). */
  events: number;
  /** Ordens abertas canceladas pelo fim da negociação. */
  cancelled: number;
}

/**
 * O fechamento da recompra (Plano do encerramento e da recompra, T3; Dividendos e recompra, critérios 17 a 20, 23, 24
 * e 29). Roda no fim de cada passada de fechamento dos eventos (`CloseEventsService.registerAfterPass`), com os
 * eventos regulares já gravados: se a temporada está em `trading`, todas as competições fecharam
 * (`buybackCloseTime`) e já passou a margem de 2 minutos da F12, numa transação só:
 *
 * 1. trava a temporada (exclusiva), todos os clubes por ticker, as carteiras com ordens abertas e a tesouraria (a
 *    linha "Fechar a recompra" da arquitetura), e confere de novo, com a temporada travada, que a recompra fecha (a
 *    edição de jogo trava a temporada compartilhada, então os resultados não mudam até o `COMMIT`);
 * 2. lê D do relógio depois das travas e chama `market.endTrading(tx, D)` (F9): ordens canceladas com as reservas
 *    devolvidas, a casa sem cotar, `trading_ended` e `trading_ended_at` (que nunca fica antes do último negócio: o D
 *    gravado é o que vale);
 * 3. grava um evento `buyback` `pending` por clube listado, inclusive R$ 0,00, com `closed_at` = D, e a foto das
 *    posições em D (`holdingsAt`, com as ações que estavam em ordens de venda, sem a tesouraria). Com tudo travado e a
 *    negociação parada, a foto em D é a posição de agora: dispensa a margem de 2 minutos que os outros eventos usam;
 * 4. avisa o `RankingsPort` na mesma transação (a partir de D as ações valem R$ 0,00 e conta a recompra a receber).
 *
 * Depois do `COMMIT`: `season.status` (pelo `endTrading`), o `wake()` dos rankings e o `admin.pending`. A casa não é
 * chamada a repor nada: ela para de cotar. Repetível: temporada já em `trading_ended` não faz nada; a passada seguinte
 * só refaz a prévia da recompra (`BUYBACK_EVENTS`, T5).
 */
@Injectable()
export class BuybackCloseService implements OnModuleInit {
  private readonly logger = new Logger("Recompra");

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly closeEvents: CloseEventsService,
    private readonly engineInput: EngineInputService,
    private readonly endTrading: EndTradingService,
    private readonly rankings: RankingsPort,
    private readonly clock: Clock,
    @Optional() private readonly events?: PayoutEvents,
  ) {}

  onModuleInit(): void {
    this.closeEvents.registerSource(BUYBACK_EVENTS);
    this.closeEvents.registerAfterPass(async (seasonId, loaded, now) => {
      await this.closeIfDue(seasonId, loaded, now);
    });
  }

  /** Se a recompra fecha agora pela entrada lida: todas as competições fecharam há ao menos 2 minutos. */
  static isDue(loaded: SeasonEngineInput, now: Date): boolean {
    if (loaded.tradingEndedAt !== null) return false;
    const close = buybackCloseTime(eventsResultOf(loaded).closes);
    return close !== undefined && close <= now.getTime() - CLOSE_MARGIN_MS;
  }

  /** O passo do fim da passada: fecha a recompra se é a hora; senão (ou se já fechou), não faz nada e devolve `null`. */
  async closeIfDue(seasonId: number, loaded: SeasonEngineInput, now: Date): Promise<BuybackCloseResult | null> {
    if (!BuybackCloseService.isDue(loaded, now)) return null;
    const [season] = await this.db.select({ status: seasons.status }).from(seasons).where(eq(seasons.id, seasonId));
    if (season?.status !== "trading") return null;
    const result = await withTransaction(this.db, (tx) => this.closeTx(tx, seasonId, now));
    if (result) this.logger.log(`temporada ${seasonId}: recompra fechada em ${result.at.toISOString()} (${result.events} clubes, ${result.cancelled} ordens canceladas)`);
    return result;
  }

  private async closeTx(tx: Tx, seasonId: number, now: Date): Promise<BuybackCloseResult | null> {
    // 1. a temporada exclusiva: nenhuma edição de jogo, aprovação, ordem de mercado inteiro ou encerramento anda junto
    const season = await lockSeason(tx, seasonId, "update");
    if (season.status !== "trading" || season.tradingEndedAt !== null) return null;
    const loaded = await this.engineInput.load(tx, seasonId);
    if (!BuybackCloseService.isDue(loaded, now)) return null;

    const tickers = (
      await tx.db
        .select({ ticker: clubs.ticker })
        .from(seasonClubs)
        .innerJoin(clubs, eq(clubs.id, seasonClubs.clubId))
        .where(eq(seasonClubs.seasonId, seasonId))
    ).map((r) => r.ticker!);
    await lockClubs(tx, seasonId, tickers);
    // com os clubes travados nenhuma ordem nova entra: a lista das carteiras com ordens abertas não muda mais
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

    // 2. D depois das travas; o `endTrading` grava o instante (nunca antes do último negócio de algum clube)
    const ended = await this.endTrading.endTrading(tx, this.clock.now(), { seasonId });
    if (!ended.ended) return null;
    const at = ended.at;

    // 3. um evento por clube listado, com a foto das posições em D
    const buybacks = buybackEventsOf(loaded, at.getTime());
    for (const event of buybacks) {
      const clubId = loaded.clubIdOf(event.clubId);
      const [row] = await tx.db
        .insert(payoutEvents)
        .values({
          seasonId,
          clubId,
          eventKey: event.key,
          kind: event.kind,
          reason: event.reason,
          competition: storedCompetition(event.competition),
          ...roundAndPhase(event),
          perShare: event.perShare,
          closedAt: at,
          status: "pending",
          version: 1,
          createdAt: at,
        })
        .returning({ id: payoutEvents.id });
      await writeHoldings(tx, row!.id, await holdingsAt(tx, seasonId, clubId, at));
    }

    // 4. o "a receber" muda a partir de D
    await this.rankings.payoutsChanged(tx, { seasonId, closedAts: [at] });
    tx.afterCommit(async () => {
      await this.rankings.wake();
      await this.events?.adminChanged();
    });
    return { seasonId, at, events: buybacks.length, cancelled: ended.cancelled };
  }
}
