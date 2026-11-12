import { Inject, Injectable } from "@nestjs/common";
import { and, asc, count, desc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import {
  COMMON_ERROR_MESSAGES,
  type PayoutEventView,
  type PayoutHoldersQuery,
  type PayoutHoldersResponse,
  type PayoutListQuery,
  type PayoutListResponse,
} from "@futbolsa/contracts";
import { DB, type Database } from "../../../infra/db/index.js";
import { bots, clubs, payoutCredits, payoutEvents, payoutHoldings, standings, users, wallets } from "../../../infra/db/schema/index.js";
import { DomainError } from "../../../infra/http/index.js";
import { currentSeason } from "../current-season.js";
import { dues } from "./settlement.js";

/** A classificação oficial de que cada tipo de evento depende (colocação da Série A, acesso da Série B). */
export const STANDINGS_OF_KIND = { placement: "brasileirao-a", promotion: "brasileirao-b" } as const;

/**
 * A prévia dos pagamentos (Admin, "Pagamento de dividendos", critério 2): por evento, o motivo, o valor por ação,
 * as ações com jogadores e com bots, o total em R$ e, na colocação e no acesso, se a classificação oficial já foi
 * conferida. A tesouraria não recebe e nunca está na foto; a conta excluída está na foto mas não recebe (P6), então
 * fica de fora das ações e do total e aparece à parte na lista de donos.
 */
@Injectable()
export class PreviewService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async list(query: PayoutListQuery): Promise<PayoutListResponse> {
    const season = await currentSeason(this.db);
    if (!season) return { events: [] };

    // sem `status`: o que aguarda aprovação e o já aprovado; os substituídos só quando pedidos
    const filters: SQL[] = [
      eq(payoutEvents.seasonId, season.id),
      query.status ? eq(payoutEvents.status, query.status) : ne(payoutEvents.status, "superseded"),
    ];
    if (query.competition) filters.push(eq(payoutEvents.competition, query.competition));
    if (query.round !== undefined) filters.push(eq(payoutEvents.round, query.round));
    if (query.phase) filters.push(eq(payoutEvents.phase, query.phase));

    const rows = await this.db
      .select({ event: payoutEvents, club: clubs })
      .from(payoutEvents)
      .innerJoin(clubs, eq(clubs.id, payoutEvents.clubId))
      .where(and(...filters))
      .orderBy(asc(payoutEvents.closedAt), asc(clubs.ticker), asc(payoutEvents.id));
    if (rows.length === 0) return { events: [] };

    const ids = rows.map((r) => r.event.id);
    const [shares, credits, confirmed, owed] = await Promise.all([
      this.sharesOf(ids),
      this.creditsOf(ids),
      this.confirmedStandings(season.id),
      this.missingOf(season.id, ids),
    ]);

    return {
      events: rows.map(({ event: e, club }): PayoutEventView => {
        const s = shares.get(e.id) ?? { players: 0, bots: 0, holders: 0 };
        const standingsCompetition = STANDINGS_OF_KIND[e.kind as keyof typeof STANDINGS_OF_KIND];
        // liquidado é não faltar lançamento para nenhuma carteira (a regra de `settlement.ts`: na correção, o crédito é o
        // líquido, e a carteira com líquido zero não precisa de linha); o esperado é o já lançado mais o que falta
        const credited = e.status === "approved" ? (credits.get(e.id) ?? 0) : 0;
        const missing = e.status === "approved" ? (owed.get(e.id) ?? 0) : 0;
        const expected = credited + missing;
        return {
          id: e.id,
          key: e.eventKey,
          kind: e.kind as PayoutEventView["kind"],
          club: { id: club.id, ticker: club.ticker, name: club.name },
          competition: e.competition as PayoutEventView["competition"],
          round: e.round,
          phase: e.phase,
          reason: e.reason,
          perShare: e.perShare,
          closedAt: e.closedAt.toISOString(),
          status: e.status as PayoutEventView["status"],
          version: e.version,
          approvedAt: e.approvedAt?.toISOString() ?? null,
          shares: { players: s.players, bots: s.bots, total: s.players + s.bots },
          total: (s.players + s.bots) * e.perShare,
          standingsConfirmed: standingsCompetition ? (confirmed.get(standingsCompetition) ?? false) : null,
          settlement: {
            state: e.status !== "approved" ? "not_started" : missing === 0 ? "settled" : "settling",
            credited,
            expected,
          },
        };
      }),
    };
  }

  /** Os donos de um evento, do que tem mais ações para o que tem menos, com o bot marcado e a conta excluída à parte. */
  async holders(eventId: number, query: PayoutHoldersQuery): Promise<PayoutHoldersResponse> {
    const [event] = await this.db.select().from(payoutEvents).where(eq(payoutEvents.id, eventId));
    if (!event) throw new DomainError("not_found", 404, COMMON_ERROR_MESSAGES.not_found);

    const where = and(eq(payoutHoldings.eventId, eventId), ne(wallets.ownerType, "treasury"));
    const [rows, [total]] = await Promise.all([
      this.db
        .select({
          walletId: payoutHoldings.walletId,
          shares: payoutHoldings.shares,
          ownerType: wallets.ownerType,
          userStatus: users.status,
          nickname: users.nickname,
          botProfile: bots.profile,
          credited: payoutCredits.amount,
        })
        .from(payoutHoldings)
        .innerJoin(wallets, eq(wallets.id, payoutHoldings.walletId))
        .leftJoin(users, eq(users.id, wallets.userId))
        .leftJoin(bots, eq(bots.id, wallets.botId))
        .leftJoin(payoutCredits, and(eq(payoutCredits.eventId, payoutHoldings.eventId), eq(payoutCredits.walletId, payoutHoldings.walletId)))
        .where(where)
        .orderBy(desc(payoutHoldings.shares), asc(payoutHoldings.walletId))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),
      this.db.select({ n: count() }).from(payoutHoldings).innerJoin(wallets, eq(wallets.id, payoutHoldings.walletId)).where(where),
    ]);

    return {
      holders: rows.map((r) => {
        const kind = r.ownerType === "bot" ? "bot" : r.userStatus === "deleted" ? "deleted" : "player";
        return {
          walletId: r.walletId,
          kind,
          nickname: kind === "bot" ? `bot ${r.botProfile}` : kind === "deleted" ? null : r.nickname,
          shares: r.shares,
          amount: kind === "deleted" ? 0 : r.shares * event.perShare,
          credited: r.credited,
        };
      }),
      page: query.page,
      pageSize: query.pageSize,
      total: total!.n,
    };
  }

  /** Ações da foto de cada evento, de jogadores (inclusive bloqueados) e de bots, e quantas carteiras recebem. */
  private async sharesOf(ids: number[]): Promise<Map<number, { players: number; bots: number; holders: number }>> {
    const receives = sql`(${wallets.ownerType} = 'bot' or (${wallets.ownerType} = 'user' and ${users.status} <> 'deleted'))`;
    const rows = await this.db
      .select({
        eventId: payoutHoldings.eventId,
        players: sql<number>`coalesce(sum(${payoutHoldings.shares}) filter (where ${wallets.ownerType} = 'user' and ${users.status} <> 'deleted'), 0)::int`,
        bots: sql<number>`coalesce(sum(${payoutHoldings.shares}) filter (where ${wallets.ownerType} = 'bot'), 0)::int`,
        holders: sql<number>`(count(*) filter (where ${receives}))::int`,
      })
      .from(payoutHoldings)
      .innerJoin(wallets, eq(wallets.id, payoutHoldings.walletId))
      .leftJoin(users, eq(users.id, wallets.userId))
      .where(inArray(payoutHoldings.eventId, ids))
      .groupBy(payoutHoldings.eventId);
    return new Map(rows.map((r) => [r.eventId, r]));
  }

  /** Quantas carteiras ainda esperam lançamento em cada evento aprovado. */
  private async missingOf(seasonId: number, ids: number[]): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    for (const due of await dues(this.db, { seasonId, eventIds: ids })) out.set(due.eventId, (out.get(due.eventId) ?? 0) + 1);
    return out;
  }

  private async creditsOf(ids: number[]): Promise<Map<number, number>> {
    const rows = await this.db
      .select({ eventId: payoutCredits.eventId, n: count() })
      .from(payoutCredits)
      .where(inArray(payoutCredits.eventId, ids))
      .groupBy(payoutCredits.eventId);
    return new Map(rows.map((r) => [r.eventId, r.n]));
  }

  /** Conferida é a tabela com linhas em que todas têm a conferência (a mesma regra da tela da classificação). */
  private async confirmedStandings(seasonId: number): Promise<Map<string, boolean>> {
    const rows = await this.db
      .select({
        competition: standings.competition,
        total: count(),
        confirmed: sql<number>`count(${standings.confirmedAt})::int`,
      })
      .from(standings)
      .where(eq(standings.seasonId, seasonId))
      .groupBy(standings.competition);
    return new Map(rows.map((r) => [r.competition, r.total > 0 && r.total === r.confirmed]));
  }
}
