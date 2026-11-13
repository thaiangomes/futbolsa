import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { createBot, Rng, type Bot, type BotProfile, type PriceBand } from "@futbolsa/engine";
import { Clock } from "../../../infra/clock/index.js";
import { DB, type Database, lockClubs, lockSeason, withTransaction } from "../../../infra/db/index.js";
import { bots, clubs, ipoBids, orders, seasonClubs, wallets } from "../../../infra/db/schema/index.js";
import { SEASON_START_CASH } from "../../accounts/season-start.js";
import { EntryService } from "../../entry/enter.service.js";
import { IpoBidsService } from "../../ipo/bids.service.js";
import { CancelService } from "../../market/orders/cancel.service.js";
import { openOrderTickers } from "../../market/orders/closure-hook.js";
import { OrderService } from "../../market/orders/order.service.js";
import { PortfolioLedger } from "../../portfolio/portfolio.module.js";
import { currentSeason } from "../current-season.js";
import { LiveBotView, type BotIntent } from "./live-view.js";
import { BotSnapshotService } from "./market-snapshot.js";

/**
 * O ritmo dos bots (proposta 2 da F14): a simulação calibrada faz cada bot decidir com chance 0,25 a cada passo de 3
 * horas. A tarefa roda a cada `BOT_TICK_MINUTES` (padrão 15) e cada bot age com chance `0,25 × 15 ÷ 180` ≈ 2,1% por
 * rodada, o mesmo ritmo médio espalhado no tempo. Os dois números ficam em variável de ambiente, para calibrar no ensaio.
 */
export interface BotRunnerConfig {
  tickMinutes: number;
  /** A chance de agir a cada 3 horas na simulação calibrada. */
  activityPer3h: number;
}

export function botRunnerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BotRunnerConfig {
  const tick = Number(env.BOT_TICK_MINUTES ?? 15);
  const activity = Number(env.BOT_ACTIVITY ?? 0.25);
  if (!Number.isFinite(tick) || tick <= 0) throw new Error(`BOT_TICK_MINUTES inválido: ${env.BOT_TICK_MINUTES}`);
  if (!Number.isFinite(activity) || activity < 0 || activity > 1) throw new Error(`BOT_ACTIVITY inválido: ${env.BOT_ACTIVITY}`);
  return { tickMinutes: tick, activityPer3h: activity };
}

/** A configuração do runner, injetada para os testes trocarem o ritmo. */
export abstract class BotRunnerSettings {
  abstract get config(): BotRunnerConfig;
}

export interface BotRunReport {
  /** A rodada anterior ainda rodava. */
  skipped: boolean;
  status: string | null;
  /** Bots que decidiram agir nesta rodada. */
  acted: number;
  /** Ordens aceitas e cancelamentos feitos. */
  placed: number;
  cancelled: number;
  /** Ofertas do IPO feitas. */
  bids: number;
  /** Carteiras abertas ou entradas feitas. */
  wallets: number;
  /** Ordens de bot desligado canceladas na varredura. */
  swept: number;
  /** Recusas contadas por código, sem parar a rodada. */
  refused: Record<string, number>;
}

const emptyReport = (): BotRunReport => ({ skipped: false, status: null, acted: 0, placed: 0, cancelled: 0, bids: 0, wallets: 0, swept: 0, refused: {} });

/**
 * A tarefa dos bots ao vivo (Admin, critérios 29 e 30; T12 da F14). A cada rodada, conforme a fase da temporada:
 * - `ipo_open`: abre a carteira de quem foi ligado e não tem e faz as ofertas (`ipoBids` do perfil, pelo `IpoBidsService`) de
 *   quem ainda não ofertou, uma vez por bot, como na simulação;
 * - `trading`: monta a visão uma vez, sorteia cada bot pela chance e, para cada um que age, roda `act(view)`; as intenções
 *   viram cancelamentos (motivo `player`: é o dono cancelando) e ordens pelo `placeOrder` da F9, cada uma na sua transação.
 *   Recusa (faixa de 20%, 50 ordens, clube suspenso, bot desligado) é contada e não para a rodada;
 * - qualquer fase: varredura das ordens abertas de bot desligado (rede de segurança da trava `bot_inactive`).
 *
 * Uma rodada por vez. Rodada perdida com a API fora não é recuperada: o bot só decide mais tarde, e nenhuma regra de dinheiro
 * muda. Os bots não passam pelo HTTP nem pelo limitador de taxa; passam pelas mesmas recusas dos jogadores.
 *
 * O estado de cada bot fica na memória da API. A semente sai de (temporada, id do bot), então o erro pessoal de estimativa e a
 * margem são os mesmos depois de reiniciar; o que se perde ao reiniciar são as apostas abertas do trader e o "empolgado" do
 * torcedor (proposta 11).
 */
@Injectable()
export class BotRunner {
  private readonly logger = new Logger("Bots");
  private readonly instances = new Map<string, Bot>();
  private running = false;

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly clock: Clock,
    private readonly snapshots: BotSnapshotService,
    private readonly orders: OrderService,
    private readonly cancels: CancelService,
    private readonly ipo: IpoBidsService,
    private readonly ledger: PortfolioLedger,
    private readonly entry: EntryService,
    private readonly settings: BotRunnerSettings,
  ) {}

  /** A chance de cada bot agir numa rodada. */
  get chancePerRound(): number {
    const { tickMinutes, activityPer3h } = this.settings.config;
    return (activityPer3h * tickMinutes) / 180;
  }

  async runOnce(now: Date = this.clock.now(), random: () => number = Math.random): Promise<BotRunReport> {
    if (this.running) return { ...emptyReport(), skipped: true };
    this.running = true;
    try {
      const report = emptyReport();
      const season = await currentSeason(this.db);
      if (!season) return report;
      report.status = season.status;
      await this.sweepInactive(season.id, now, report);
      if (season.status === "ipo_open") await this.ipoRound(season, now, report);
      else if (season.status === "trading") await this.tradingRound(season.id, now, random, report);
      return report;
    } finally {
      this.running = false;
    }
  }

  /** Cancela as ordens abertas de bot desligado (`bot_off`). */
  private async sweepInactive(seasonId: number, now: Date, report: BotRunReport): Promise<void> {
    const rows = await this.db
      .selectDistinct({ walletId: orders.walletId })
      .from(orders)
      .innerJoin(wallets, eq(wallets.id, orders.walletId))
      .innerJoin(bots, eq(bots.id, wallets.botId))
      .where(and(eq(orders.seasonId, seasonId), eq(orders.status, "open"), eq(bots.active, false)))
      .orderBy(asc(orders.walletId));
    for (const { walletId } of rows) {
      // uma carteira que falha não derruba a rodada: a próxima varredura tenta de novo
      try {
        report.swept += await this.cancelAllOf(seasonId, walletId, "bot_off", now);
      } catch (error) {
        this.refuse(report, error);
      }
    }
  }

  private async ipoRound(season: { id: number }, now: Date, report: BotRunReport): Promise<void> {
    // 1. a carteira de quem foi ligado e ainda não tem
    const active = await this.db.select().from(bots).where(eq(bots.active, true)).orderBy(asc(bots.id));
    if (active.length === 0) return;
    const owned = await this.db
      .select({ id: wallets.id, botId: wallets.botId })
      .from(wallets)
      .where(and(eq(wallets.seasonId, season.id), inArray(wallets.botId, active.map((b) => b.id))));
    const walletOf = new Map(owned.map((w) => [w.botId!, w.id]));
    for (const bot of active) {
      if (walletOf.has(bot.id)) continue;
      try {
        // com a temporada travada: o IPO pode ter fechado, o bot pode ter sido desligado ou um admin pode ter aberto a carteira
        const opened = await withTransaction(this.db, async (tx) => {
          const locked = await lockSeason(tx, season.id, "share");
          if (locked.status !== "ipo_open") return undefined;
          const [row] = await tx.db.select({ active: bots.active }).from(bots).where(eq(bots.id, bot.id));
          if (!row?.active) return undefined;
          const [exists] = await tx.db.select({ id: wallets.id }).from(wallets).where(and(eq(wallets.seasonId, season.id), eq(wallets.botId, bot.id)));
          if (exists) return undefined;
          return this.ledger.openWallet(tx, { seasonId: season.id, owner: { type: "bot", botId: bot.id }, at: now, entryMode: "ipo", initialCash: SEASON_START_CASH });
        });
        if (opened) {
          walletOf.set(bot.id, opened.id);
          report.wallets++;
        }
      } catch (error) {
        this.refuse(report, error);
      }
    }

    // 2. as ofertas de quem ainda não ofertou
    const bidders = new Set(
      (await this.db.selectDistinct({ walletId: ipoBids.walletId }).from(ipoBids).where(eq(ipoBids.seasonId, season.id))).map((r) => r.walletId),
    );
    const pending = active.filter((b) => walletOf.has(b.id) && !bidders.has(walletOf.get(b.id)!));
    if (pending.length === 0) return;
    const snapshot = await this.snapshots.load(season.id, now);
    const bands = await this.bands(season.id);
    const prev = await this.prevPlacements(season.id);
    for (const row of pending) {
      const bot = this.instance(season.id, row.id, row.profile as BotProfile, snapshot.clubIds, prev);
      const cash = SEASON_START_CASH;
      const view = new LiveBotView({ ...snapshot, wallets: new Map([[String(row.id), { cash, reservedCash: 0, positions: new Map() }]]) });
      for (const [ticker, bid] of bot.ipoBids(view, bands, cash)) {
        try {
          await this.ipo.place(walletOf.get(row.id)!, ticker, { quantity: bid.quantity, maxPrice: bid.maxPrice, expect: "new" });
          report.bids++;
        } catch (error) {
          this.refuse(report, error);
        }
      }
    }
  }

  private async tradingRound(seasonId: number, now: Date, random: () => number, report: BotRunReport): Promise<void> {
    const active = await this.db.select().from(bots).where(eq(bots.active, true)).orderBy(asc(bots.id));
    if (active.length === 0) return;
    const owned = await this.db
      .select({ id: wallets.id, botId: wallets.botId })
      .from(wallets)
      .where(and(eq(wallets.seasonId, seasonId), inArray(wallets.botId, active.map((b) => b.id))));
    const walletOf = new Map(owned.map((w) => [w.botId!, w.id]));
    // bot ligado que ainda não tem carteira (IPO liquidando, mercado suspenso na hora) entra agora, se a janela deixa
    for (const bot of active) {
      if (walletOf.has(bot.id)) continue;
      try {
        const entered = await this.entry.enterBot(bot.id);
        walletOf.set(bot.id, entered.walletId);
        report.wallets++;
      } catch (error) {
        this.refuse(report, error);
      }
    }

    const snapshot = await this.snapshots.load(seasonId, now);
    const view = new LiveBotView(snapshot);
    const prev = await this.prevPlacements(seasonId);
    const chance = this.chancePerRound;
    for (const row of active) {
      if (!walletOf.has(row.id) || !snapshot.wallets.has(String(row.id))) continue;
      if (random() >= chance) continue;
      this.instance(seasonId, row.id, row.profile as BotProfile, snapshot.clubIds, prev).act(view);
      report.acted++;
    }
    for (const intent of view.intents) await this.execute(seasonId, intent, walletOf, now, report);
  }

  private async execute(seasonId: number, intent: BotIntent, walletOf: Map<number, number>, now: Date, report: BotRunReport): Promise<void> {
    const walletId = walletOf.get(Number(intent.botId));
    if (walletId === undefined) return;
    try {
      if (intent.kind === "cancelAll") {
        report.cancelled += await this.cancelAllOf(seasonId, walletId, "player", now);
        return;
      }
      const result = await this.orders.place(
        {
          seasonId,
          ticker: intent.ticker,
          walletId,
          actor: "bot",
          side: intent.side,
          type: intent.kind === "limit" ? "limit" : "market",
          quantity: intent.quantity,
          ...(intent.kind === "limit" ? { limitPrice: intent.limitPrice } : {}),
          now,
        },
        { hooks: { afterWalletsLocked: async (tx, wallet) => this.refuseInactive(tx, wallet.botId) } },
      );
      if (result.ok) report.placed++;
      else report.refused[result.code] = (report.refused[result.code] ?? 0) + 1;
    } catch (error) {
      this.refuse(report, error);
    }
  }

  /**
   * A porta do dono (proposta 10 da F14): conferida com a carteira do bot já travada, dentro da transação da ordem. O
   * desligamento trava a carteira antes de cancelar as ordens, então um desligamento que confirma no meio da ordem é visto aqui.
   */
  private async refuseInactive(tx: { db: Database }, botId: number | null) {
    if (botId === null) return { ok: false as const, code: "bot_inactive" as const };
    const [row] = await tx.db.select({ active: bots.active }).from(bots).where(eq(bots.id, botId));
    return row?.active ? undefined : { ok: false as const, code: "bot_inactive" as const };
  }

  /** Cancela todas as ordens abertas da carteira, com os clubes travados na ordem do jogo. */
  private async cancelAllOf(seasonId: number, walletId: number, reason: "player" | "bot_off", now: Date): Promise<number> {
    return withTransaction(this.db, async (tx) => {
      await lockSeason(tx, seasonId, "share");
      await lockClubs(tx, seasonId, await openOrderTickers(tx, walletId));
      const done = await this.cancels.cancelOrders(tx, walletId, {}, reason, now);
      return done.orders.length;
    });
  }

  private async bands(seasonId: number): Promise<Map<string, PriceBand>> {
    const rows = await this.db
      .select({ ticker: clubs.ticker, floor: seasonClubs.bandFloor, center: seasonClubs.bandCenter, ceiling: seasonClubs.bandCeiling })
      .from(seasonClubs)
      .innerJoin(clubs, eq(clubs.id, seasonClubs.clubId))
      .where(eq(seasonClubs.seasonId, seasonId))
      .orderBy(asc(clubs.ticker));
    const out = new Map<string, PriceBand>();
    for (const r of rows) if (r.floor !== null && r.ceiling !== null) out.set(r.ticker!, { min: r.floor, max: r.ceiling, center: r.center ?? Math.round((r.floor + r.ceiling) / 2) });
    return out;
  }

  /** A colocação de cada clube no ano anterior (o analista). */
  private async prevPlacements(seasonId: number): Promise<Map<string, number>> {
    const rows = await this.db
      .select({ ticker: clubs.ticker, prev: seasonClubs.prevPlacement })
      .from(seasonClubs)
      .innerJoin(clubs, eq(clubs.id, seasonClubs.clubId))
      .where(and(eq(seasonClubs.seasonId, seasonId), sql`${seasonClubs.prevPlacement} is not null`));
    return new Map(rows.map((r) => [r.ticker!, r.prev!]));
  }

  /** O bot de cada id, criado uma vez e guardado na memória; a semente sai de (temporada, id). */
  private instance(seasonId: number, botId: number, profile: BotProfile, tickers: readonly string[], lastYear: Map<string, number>): Bot {
    const key = `${seasonId}:${botId}`;
    let bot = this.instances.get(key);
    if (!bot) {
      const seed = (seasonId * 1_000_003 + botId) >>> 0;
      bot = createBot(profile, String(botId), new Rng(seed), {
        ...(tickers.length ? { fanClubId: tickers[botId % tickers.length]! } : {}),
        lastYear,
      });
      this.instances.set(key, bot);
    }
    return bot;
  }

  private refuse(report: BotRunReport, error: unknown): void {
    const code = (error as { code?: string }).code ?? "error";
    report.refused[code] = (report.refused[code] ?? 0) + 1;
    if (!(error as { status?: number }).status) this.logger.warn(`bot: ${(error as Error).message}`);
  }
}
