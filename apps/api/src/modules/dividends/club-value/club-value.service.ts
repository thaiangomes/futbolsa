import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, lte, ne, or, sql } from "drizzle-orm";
import type { ClubValueCup, ClubValueView } from "@futbolsa/contracts";
import { Clock } from "../../../infra/clock/index.js";
import { DB, type Database } from "../../../infra/db/index.js";
import { clubs, matches, payoutEvents, seasonClubs, seasonRules, standings } from "../../../infra/db/schema/index.js";
import { CUP_COMPETITIONS } from "../../../infra/db/schema/values.js";
import { DomainError } from "../../../infra/http/index.js";
import { currentSeason } from "../../admin/current-season.js";
import { SeasonValuesService } from "../season-values/season-values.service.js";
import { cupOutcomeOf, cupPhaseOf } from "./cup-status.js";

const notListed = () => new DomainError("club_not_listed", 404, "Este clube não está listado na temporada.");

/**
 * `GET /clubs/:ticker/dividends` (T12): o que a tela do clube precisa para o "Quanto vale para você". Só dado público e a
 * regra da temporada: o que a ação já pagou e tem a receber, os pontos e a colocação no campeonato, a fase atual de cada
 * copa que o clube disputa e os valores fixos. Não lê nem devolve o valor justo da casa (decisão do Thaian em 2026-11-01).
 */
@Injectable()
export class ClubValueService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly clock: Clock,
    private readonly seasonValues: SeasonValuesService,
  ) {}

  async view(ticker: string): Promise<ClubValueView> {
    const season = await currentSeason(this.db);
    if (!season) throw notListed();
    const [club] = await this.db
      .select({ clubId: seasonClubs.clubId, division: seasonClubs.division })
      .from(seasonClubs)
      .innerJoin(clubs, eq(clubs.id, seasonClubs.clubId))
      .where(and(eq(seasonClubs.seasonId, season.id), eq(clubs.ticker, ticker)));
    if (!club) throw notListed();

    let values;
    try {
      values = await this.seasonValues.readSeasonValues(this.db, season.id);
    } catch {
      throw notListed(); // temporada ainda sem valores (em preparação): não há o que simular
    }
    const league = club.division === "A" ? ("brasileirao-a" as const) : ("brasileirao-b" as const);
    const rules = values.leagues[league]!;

    const [standing] = await this.db
      .select({ points: standings.points, position: standings.position })
      .from(standings)
      .where(and(eq(standings.seasonId, season.id), eq(standings.competition, league), eq(standings.clubId, club.clubId)));
    const totals = await this.perShareTotals(season.id, club.clubId);

    return {
      ticker,
      league,
      leagueRules: {
        perPoint: rules.perPoint,
        placement: rules.placement,
        ...(rules.qualification ? { qualification: rules.qualification } : {}),
        ...(rules.penalty ? { penalty: rules.penalty } : {}),
      },
      leagueOpen: await this.leagueOpen(season.id, league),
      points: standing?.points ?? 0,
      position: standing?.position ?? null,
      played: await this.played(season.id, club.clubId, league),
      paid: totals.paid,
      toReceive: totals.toReceive,
      buybackMultipleBp: await this.buybackMultiple(season.id),
      cups: await this.cups(season.id, club.clubId, values),
    };
  }

  /** O múltiplo da recompra da temporada, em pontos-base (15.000 = 1,5×). */
  private async buybackMultiple(seasonId: number): Promise<number> {
    const [row] = await this.db.select({ bp: seasonRules.buybackMultipleBp }).from(seasonRules).where(eq(seasonRules.seasonId, seasonId));
    return row?.bp ?? 15_000;
  }

  /**
   * Pago por ação (soma das versões vigentes aprovadas) e a receber (versões vigentes ainda `pending` já fechadas): a mesma
   * conta de `perShareTotals` dos pagamentos (F12, T9), sem a recompra, que o simulador calcula à parte.
   */
  private async perShareTotals(seasonId: number, clubId: number): Promise<{ paid: number; toReceive: number }> {
    const rows = await this.db
      .select({ status: payoutEvents.status, total: sql<number>`coalesce(sum(${payoutEvents.perShare}), 0)::int` })
      .from(payoutEvents)
      .where(
        and(
          eq(payoutEvents.seasonId, seasonId),
          eq(payoutEvents.clubId, clubId),
          ne(payoutEvents.kind, "buyback"),
          ne(payoutEvents.status, "superseded"),
          lte(payoutEvents.closedAt, this.clock.now()),
        ),
      )
      .groupBy(payoutEvents.status);
    const by = new Map(rows.map((r) => [r.status, r.total]));
    return { paid: by.get("approved") ?? 0, toReceive: by.get("pending") ?? 0 };
  }

  /** Os jogos já disputados do clube no campeonato. */
  private async played(seasonId: number, clubId: number, league: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(matches)
      .where(and(eq(matches.seasonId, seasonId), eq(matches.competition, league), eq(matches.status, "finished"), or(eq(matches.homeClubId, clubId), eq(matches.awayClubId, clubId))));
    return row?.n ?? 0;
  }

  /** O campeonato está aberto enquanto há jogo por disputar; sem nenhum jogo (antes da estreia), também. */
  private async leagueOpen(seasonId: number, league: string): Promise<boolean> {
    const [row] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        open: sql<number>`count(*) filter (where ${matches.status} in ('scheduled', 'postponed'))::int`,
      })
      .from(matches)
      .where(and(eq(matches.seasonId, seasonId), eq(matches.competition, league)));
    return !row || row.total === 0 || row.open > 0;
  }

  private async cups(seasonId: number, clubId: number, values: Awaited<ReturnType<SeasonValuesService["readSeasonValues"]>>): Promise<ClubValueCup[]> {
    const rows = await this.db
      .select({
        competition: matches.competition,
        phase: matches.phase,
        status: matches.status,
        homeClubId: matches.homeClubId,
        awayClubId: matches.awayClubId,
        advancedClubId: matches.advancedClubId,
        homeGoals: matches.homeGoals,
        awayGoals: matches.awayGoals,
        kickoff: matches.kickoff,
      })
      .from(matches)
      .where(and(eq(matches.seasonId, seasonId), inArray(matches.competition, [...CUP_COMPETITIONS])));
    const cups: ClubValueCup[] = [];
    for (const competition of CUP_COMPETITIONS) {
      const rules = values.cups[competition];
      if (!rules) continue;
      const ofCup = rows.filter((r) => r.competition === competition);
      const current = cupPhaseOf(ofCup, clubId, rules.phases);
      if (current === undefined) continue; // o clube não disputa esta copa
      const outcome = cupOutcomeOf(ofCup, clubId, rules.phases) ?? "playing";
      cups.push({
        competition,
        phases: rules.phases,
        advance: rules.advance,
        ...(rules.advanceTo ? { advanceTo: rules.advanceTo } : {}),
        title: rules.title,
        currentPhase: current,
        outcome,
      });
    }
    return cups;
  }
}
