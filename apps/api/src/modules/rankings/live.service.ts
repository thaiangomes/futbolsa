import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { monthKey } from "@futbolsa/engine";
import { type LiveRanking, type RankingsLiveEvent, rankingsLiveEventSchema } from "@futbolsa/contracts";
import { Clock } from "../../infra/clock/index.js";
import { DB, type Database, withTransaction } from "../../infra/db/index.js";
import { EventBus } from "../../infra/realtime/index.js";
import { currentSeason } from "../admin/current-season.js";
import { EQUITY_BASE_CENTS } from "../portfolio/valuation/constants.js";
import { baseOf } from "./base.js";
import { buildRanking, type BuiltRow } from "./build-ranking.js";
import { measure } from "./close.js";
import { participants } from "./participants.js";
import { returnOf, toRankingRows } from "./view.js";

/** Quanto tempo a parcial calculada vale para todos (P5). */
export const LIVE_CACHE_MS = 5_000;

type Period = "month" | "season";

interface Computed {
  seasonId: number;
  period: Period;
  periodKey: string;
  computedAt: Date;
  botsIncluded: boolean;
  rows: BuiltRow[];
  byWallet: Map<number, BuiltRow>;
}

interface Entry {
  at: number;
  botsIncluded: boolean;
  seasonId: number;
  value?: Computed;
  pending?: Promise<Computed>;
}

/**
 * A parcial ao vivo (T7): um cálculo só para todos, guardado por 5 segundos (pedidos que chegam durante o cálculo
 * esperam o mesmo). A chave "bots nos rankings" é lida a cada pedido e entra na chave do cache, então liga e desliga na
 * hora. O patrimônio vem do mesmo `EquityAt` da carteira, em T = agora, então a parcial e `GET /portfolio` concordam.
 */
@Injectable()
export class LiveService {
  private readonly cache = new Map<Period, Entry>();
  private lastSignature = new Map<Period, string>();
  /** Quantos cálculos de verdade já rodaram (os testes contam). */
  computations = 0;

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly clock: Clock,
    private readonly bus: EventBus,
  ) {
    bus.registerSchema("rankings.live", rankingsLiveEventSchema);
  }

  private async compute(seasonId: number, year: number, period: Period, botsIncluded: boolean, now: Date): Promise<Computed> {
    this.computations++;
    const periodKey = period === "month" ? monthKey(now.getTime()) : String(year);
    const rows = await withTransaction(
      this.db,
      async (tx) => {
        const people = await participants(tx, seasonId, now, { botsIncluded });
        const measured = await measure(tx, seasonId, now, people, (list) =>
          period === "season" ? Promise.resolve(new Map(list.map((p) => [p.walletId, EQUITY_BASE_CENTS]))) : baseOf(tx, seasonId, periodKey, list),
        );
        return buildRanking(measured);
      },
      { isolationLevel: "repeatable read", readOnly: true },
    );
    return { seasonId, period, periodKey, computedAt: now, botsIncluded, rows, byWallet: new Map(rows.map((r) => [r.walletId, r])) };
  }

  /** A parcial de agora (do cache se tem menos de 5 s e a chave dos bots não mudou). `null` sem temporada em curso. */
  async current(period: Period, options: { force?: boolean } = {}): Promise<Computed | null> {
    const season = await currentSeason(this.db);
    if (!season) return null;
    const now = this.clock.now();
    const entry = this.cache.get(period);
    if (!options.force && entry && entry.seasonId === season.id && entry.botsIncluded === season.botsInRankings && now.getTime() - entry.at < LIVE_CACHE_MS) {
      return entry.value ?? entry.pending!;
    }
    const pending = this.compute(season.id, season.year, period, season.botsInRankings, now);
    const fresh: Entry = { at: now.getTime(), botsIncluded: season.botsInRankings, seasonId: season.id, pending };
    this.cache.set(period, fresh);
    try {
      fresh.value = await pending;
      fresh.pending = undefined;
      return fresh.value;
    } catch (error) {
      this.cache.delete(period);
      throw error;
    }
  }

  /** `GET /rankings/live`: a página pedida e a linha de quem pediu. */
  async view(args: { period: Period; offset: number; limit: number; userId?: string }): Promise<LiveRanking> {
    const seq = this.bus.currentSeq("rankings"); // antes do banco (P2 do Plano do WebSocket)
    const snap = await this.current(args.period);
    if (!snap) {
      return { period: args.period, periodKey: "", computedAt: this.clock.now().toISOString(), seq, botsIncluded: false, total: 0, offset: args.offset, rows: [], me: null };
    }
    const page = snap.rows.slice(args.offset, args.offset + args.limit);
    let myWallet: number | undefined;
    if (args.userId) {
      const r = await this.db.execute(sql`select id from futbolsa.wallets where season_id = ${snap.seasonId} and user_id = ${args.userId}`);
      if (r.rows[0]) myWallet = Number(r.rows[0].id);
    }
    const mine = myWallet === undefined ? undefined : snap.byWallet.get(myWallet);
    const wanted = [...page, ...(mine ? [mine] : [])].map((r) => ({ walletId: r.walletId, position: r.position, returnBp: returnOf(r.equity, r.base) }));
    const shown = await withTransaction(this.db, (tx) => toRankingRows(tx, snap.seasonId, wanted), { readOnly: true });
    return {
      period: snap.period,
      periodKey: snap.periodKey,
      computedAt: snap.computedAt.toISOString(),
      seq,
      botsIncluded: snap.botsIncluded,
      total: snap.rows.length,
      offset: args.offset,
      rows: shown.slice(0, page.length),
      me: mine ? shown[page.length]! : null,
    };
  }

  /** O que muda a parcial sem passar pelo relógio: o último negócio, a chave dos bots, quem entrou, as contas bloqueadas e os eventos de pagamento. */
  private async signature(seasonId: number): Promise<string> {
    const r = await this.db.execute(sql`
      select
        (select coalesce(max(last_trade_at)::text, '') from futbolsa.season_clubs where season_id = ${seasonId}) as trade,
        (select bots_in_rankings::text from futbolsa.seasons where id = ${seasonId}) as bots,
        (select count(*)::text from futbolsa.wallets where season_id = ${seasonId}) as wallets,
        (select count(*)::text from futbolsa.users u join futbolsa.wallets w on w.user_id = u.id where w.season_id = ${seasonId} and u.status <> 'active') as inactive,
        (select count(*)::text || ':' || coalesce(max(approved_at)::text, '') || ':' || coalesce(max(version)::text, '') from futbolsa.payout_events where season_id = ${seasonId} and status <> 'superseded') as payouts`);
    return Object.values(r.rows[0] ?? {}).join("|");
  }

  /** A tarefa `rankings-live` (a cada 10 s): publica `rankings.live` dos dois períodos, só se algo mudou desde o último. */
  async publishIfChanged(): Promise<Period[]> {
    const season = await currentSeason(this.db);
    if (!season || season.status === "preparing") return [];
    const signature = await this.signature(season.id);
    const published: Period[] = [];
    for (const period of ["month", "season"] as const) {
      if (this.lastSignature.get(period) === signature) continue;
      const snap = await this.current(period, { force: true });
      if (!snap) continue;
      const top = await withTransaction(
        this.db,
        (tx) => toRankingRows(tx, snap.seasonId, snap.rows.slice(0, 20).map((r) => ({ walletId: r.walletId, position: r.position, returnBp: returnOf(r.equity, r.base) }))),
        { readOnly: true },
      );
      const event: RankingsLiveEvent = { period, periodKey: snap.periodKey, computedAt: snap.computedAt.toISOString(), total: snap.rows.length, top };
      this.bus.publish("rankings", "rankings.live", event);
      this.lastSignature.set(period, signature);
      published.push(period);
    }
    return published;
  }
}
