import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  ADMIN_ERROR_MESSAGES,
  type AdminMatch,
  COMMON_ERROR_MESSAGES,
  type CompetitionCode,
  type CreateMatchBody,
  type ListMatchesQuery,
  type PatchMatchBody,
} from "@futbolsa/contracts";
import { DB, type Database, lockSeason, type Tx, withTransaction } from "../../../infra/db/index.js";
import { clubs, matches } from "../../../infra/db/schema/index.js";
import { DomainError } from "../../../infra/http/index.js";
import { currentSeason } from "../current-season.js";
import { AdminLogService } from "../log/index.js";
import { assertLatestNotClosed, assertSeasonOpen } from "../seasons/season-state.js";
import { MarketPort, MatchesEvents, notifyAfterCommit } from "./ports.js";
import type { SourceSnapshot } from "./import.service.js";
import type { MatchRow } from "./to-engine.js";

type ClubRow = typeof clubs.$inferSelect;

const invalid = (...fields: string[]) => new DomainError("invalid_input", 400, COMMON_ERROR_MESSAGES.invalid_input, fields);
const tradingEnded = () => new DomainError("season_trading_ended", 409, ADMIN_ERROR_MESSAGES.season_trading_ended);

/** O jogo como o registro do admin o guarda (antes e depois). */
function logView(row: MatchRow) {
  return {
    competition: row.competition,
    round: row.round,
    phase: row.phase,
    homeClubId: row.homeClubId,
    awayClubId: row.awayClubId,
    kickoff: row.kickoff.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    status: row.status,
    homeGoals: row.homeGoals,
    awayGoals: row.awayGoals,
    advancedClubId: row.advancedClubId,
    outOfWindow: row.outOfWindow,
  };
}

const ref = (c: ClubRow) => ({ id: c.id, ticker: c.ticker, name: c.name });

/** O jogo para a tela, com o que a fonte diz e se o jogo do admin diverge dela (Admin, critério 6). */
export function toAdminMatch(row: MatchRow, home: ClubRow, away: ClubRow): AdminMatch {
  const snap = row.sourceSnapshot as SourceSnapshot | null;
  const diverges =
    row.manualOverride &&
    snap !== null &&
    (snap.status !== row.status ||
      snap.homeGoals !== row.homeGoals ||
      snap.awayGoals !== row.awayGoals ||
      new Date(snap.kickoff).getTime() !== row.kickoff.getTime());
  return {
    id: row.id,
    seasonId: row.seasonId,
    competition: row.competition as CompetitionCode,
    round: row.round,
    phase: row.phase,
    home: ref(home),
    away: ref(away),
    kickoff: row.kickoff.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    homeGoals: row.homeGoals,
    awayGoals: row.awayGoals,
    advancedClubId: row.advancedClubId,
    status: row.status as AdminMatch["status"],
    outOfWindow: row.outOfWindow,
    source: row.source,
    manualOverride: row.manualOverride,
    sourceView: snap && row.manualOverride ? snap : null,
    diverges,
  };
}

/**
 * Edição manual de jogos (Admin, critérios 6, 8, 18 e 33): cadastrar o que a fonte não trouxe, preencher
 * e corrigir placar, data e estado, marcar e desmarcar adiado, cancelar e informar quem passou. Todo
 * motivo é obrigatório e vai ao registro com o antes e o depois, na mesma transação. O jogo editado passa
 * a ser do admin (`manual_override`): a importação seguinte não o sobrescreve.
 */
@Injectable()
export class MatchesService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly log: AdminLogService,
    private readonly events: MatchesEvents,
    private readonly market: MarketPort,
  ) {}

  async list(query: ListMatchesQuery): Promise<AdminMatch[]> {
    const season = await currentSeason(this.db);
    if (!season) return [];
    const home = alias(clubs, "home");
    const away = alias(clubs, "away");
    const filters = [eq(matches.seasonId, season.id)];
    if (query.competition) filters.push(eq(matches.competition, query.competition));
    if (query.round) filters.push(eq(matches.round, query.round));
    if (query.phase) filters.push(eq(matches.phase, query.phase));
    if (query.status) filters.push(eq(matches.status, query.status));
    const rows = await this.db
      .select({ m: matches, home, away })
      .from(matches)
      .innerJoin(home, eq(home.id, matches.homeClubId))
      .innerJoin(away, eq(away.id, matches.awayClubId))
      .where(and(...filters))
      .orderBy(asc(matches.kickoff), asc(matches.id));
    const views = rows.map((r) => toAdminMatch(r.m, r.home, r.away));
    return query.diverging === undefined ? views : views.filter((v) => v.diverges === query.diverging);
  }

  async create(actorId: string, body: CreateMatchBody): Promise<AdminMatch> {
    return withTransaction(this.db, async (tx) => {
      const season = await currentSeason(tx.db);
      if (!season) {
        // sem temporada atual, a mais nova encerrada recusa: o jogo novo seria dela (Admin, critério 18)
        await assertLatestNotClosed(tx);
        throw new DomainError("no_season", 409, ADMIN_ERROR_MESSAGES.no_season);
      }
      const locked = await lockSeason(tx, season.id, "share");
      // o encerramento pode ter passado enquanto a trava era esperada
      assertSeasonOpen(locked);
      // com a recompra fechada, um jogo novo reabriria uma competição (Admin, critério 37)
      if (locked.status === "trading_ended") throw tradingEnded();
      const [home, away] = await this.clubsOf(tx, body.homeClubId, body.awayClubId);
      const isLeague = body.competition === "brasileirao-a" || body.competition === "brasileirao-b";
      if (isLeague && body.round === undefined) throw invalid("round");
      if (!isLeague && body.phase === undefined) throw invalid("phase");
      const goals = this.checkState({
        status: body.status,
        homeGoals: body.homeGoals ?? null,
        awayGoals: body.awayGoals ?? null,
        advancedClubId: body.advancedClubId ?? null,
        home,
        away,
        isCup: !isLeague,
        explicitStatus: true,
        goalsInBody: body.homeGoals != null || body.awayGoals != null,
      });
      const [row] = await tx.db
        .insert(matches)
        .values({
          seasonId: season.id,
          competition: body.competition,
          round: isLeague ? (body.round ?? null) : null,
          phase: isLeague ? null : (body.phase ?? null),
          homeClubId: home.id,
          awayClubId: away.id,
          kickoff: new Date(body.kickoff),
          finishedAt: body.finishedAt ? new Date(body.finishedAt) : null,
          status: body.status,
          homeGoals: goals.homeGoals,
          awayGoals: goals.awayGoals,
          advancedClubId: goals.advancedClubId,
          source: "manual",
          manualOverride: true,
        })
        .returning();
      await this.log.record(tx, {
        actorId,
        action: "match.create",
        targetType: "match",
        targetId: String(row!.id),
        after: logView(row!),
        reason: body.reason,
      });
      this.notify(tx, row!, home, away, body.status === "finished");
      return toAdminMatch(row!, home, away);
    });
  }

  async patch(actorId: string, id: number, body: PatchMatchBody): Promise<AdminMatch> {
    return withTransaction(this.db, async (tx) => {
      const [found] = await tx.db.select({ seasonId: matches.seasonId }).from(matches).where(eq(matches.id, id));
      if (!found) throw new DomainError("match_not_found", 404, ADMIN_ERROR_MESSAGES.match_not_found);
      const season = await lockSeason(tx, found.seasonId, "share");
      assertSeasonOpen(season);
      const [row] = await tx.db.select().from(matches).where(eq(matches.id, id)).for("update");
      if (!row) throw new DomainError("match_not_found", 404, ADMIN_ERROR_MESSAGES.match_not_found);
      const [home, away] = await this.clubsOf(tx, row.homeClubId, row.awayClubId);

      const isLeague = row.round !== null;
      if (body.round !== undefined && !isLeague) throw invalid("round");
      if (body.phase !== undefined && isLeague) throw invalid("phase");

      const bothGoals = body.homeGoals != null && body.awayGoals != null;
      const status = body.status ?? (bothGoals ? "finished" : (row.status as AdminMatch["status"]));
      // com a recompra fechada, voltar o jogo para agendado, adiar, desmarcar o adiado ou cancelar reabriria uma
      // competição (Admin, critério 37; a recompra e o fim da negociação não voltam). Corrigir o placar, quem passou ou o
      // horário do jogo disputado continua aceito: muda só os valores, pela correção
      if (season.status === "trading_ended" && status !== row.status && status !== "finished") throw tradingEnded();
      const goals = this.checkState({
        status,
        homeGoals: body.homeGoals !== undefined ? body.homeGoals : row.homeGoals,
        awayGoals: body.awayGoals !== undefined ? body.awayGoals : row.awayGoals,
        advancedClubId: body.advancedClubId !== undefined ? body.advancedClubId : row.advancedClubId,
        home,
        away,
        isCup: !isLeague,
        explicitStatus: body.status !== undefined,
        goalsInBody: body.homeGoals != null || body.awayGoals != null,
      });

      const next = {
        round: body.round ?? row.round,
        phase: body.phase ?? row.phase,
        kickoff: body.kickoff ? new Date(body.kickoff) : row.kickoff,
        finishedAt: body.finishedAt === undefined ? row.finishedAt : body.finishedAt ? new Date(body.finishedAt) : null,
        status,
        homeGoals: goals.homeGoals,
        awayGoals: goals.awayGoals,
        advancedClubId: goals.advancedClubId,
        // Marcar ou desmarcar adiado à mão zera o "fora da janela": a importação não o marca de novo.
        outOfWindow: body.status !== undefined ? false : row.outOfWindow,
      };
      // com a recompra fechada, mover o fim do jogo para depois de D (`trading_ended_at`) tiraria o dividendo dele da
      // recompra e da foto de quem já recebeu (decisão de 2026-11-13, F15): recusado. Corrigir para antes de D passa
      if (season.status === "trading_ended" && season.tradingEndedAt) {
        const endOf = (m: { finishedAt: Date | null; kickoff: Date }) => (m.finishedAt ?? m.kickoff).getTime();
        if (endOf(next) !== endOf(row) && endOf(next) > season.tradingEndedAt.getTime()) throw tradingEnded();
      }
      const [updated] = await tx.db
        .update(matches)
        .set({ ...next, manualOverride: true, updatedAt: new Date() })
        .where(eq(matches.id, id))
        .returning();
      const before = logView(row);
      const after = logView(updated!);
      if (JSON.stringify(before) === JSON.stringify(after) && row.manualOverride) return toAdminMatch(updated!, home, away);
      await this.log.record(tx, {
        actorId,
        action: "match.update",
        targetType: "match",
        targetId: String(id),
        before,
        after,
        reason: body.reason,
      });
      const scoreChanged =
        row.homeGoals !== next.homeGoals || row.awayGoals !== next.awayGoals || (row.status !== next.status && (row.status === "finished" || next.status === "finished"));
      this.notify(tx, updated!, home, away, scoreChanged, row.status === "finished" ? "correction" : "score");
      return toAdminMatch(updated!, home, away);
    });
  }

  private async clubsOf(tx: Tx, homeId: number, awayId: number): Promise<[ClubRow, ClubRow]> {
    const rows = await tx.db.select().from(clubs).where(inArray(clubs.id, [homeId, awayId]));
    const home = rows.find((c) => c.id === homeId);
    const away = rows.find((c) => c.id === awayId);
    if (!home) throw invalid("homeClubId");
    if (!away) throw invalid("awayClubId");
    return [home, away];
  }

  /** Placar só em jogo encerrado, completo; quem passou só em copa e só um dos dois clubes. */
  private checkState(s: {
    status: AdminMatch["status"];
    homeGoals: number | null;
    awayGoals: number | null;
    advancedClubId: number | null;
    home: ClubRow;
    away: ClubRow;
    isCup: boolean;
    explicitStatus: boolean;
    goalsInBody?: boolean;
  }): { homeGoals: number | null; awayGoals: number | null; advancedClubId: number | null } {
    if (s.status === "finished") {
      if (s.homeGoals === null || s.awayGoals === null) throw invalid("homeGoals", "awayGoals");
    } else if (s.goalsInBody) {
      // Placar de jogo que não está encerrado: o admin diz o estado e o placar juntos.
      throw invalid("homeGoals", "awayGoals");
    }
    const finished = s.status === "finished";
    if (s.advancedClubId !== null && finished) {
      if (!s.isCup || (s.advancedClubId !== s.home.id && s.advancedClubId !== s.away.id)) throw invalid("advancedClubId");
    }
    return {
      homeGoals: finished ? s.homeGoals : null,
      awayGoals: finished ? s.awayGoals : null,
      advancedClubId: finished ? s.advancedClubId : null,
    };
  }

  private notify(tx: Tx, row: MatchRow, home: ClubRow, away: ClubRow, scoreChanged: boolean, reason: "score" | "correction" = "score"): void {
    const tickers = scoreChanged ? [home.ticker, away.ticker].filter((t): t is string => !!t) : [];
    notifyAfterCommit(
      tx,
      { db: this.db, events: this.events, market: this.market },
      {
        seasonId: row.seasonId,
        competition: row.competition as CompetitionCode,
        matchIds: [row.id],
        clubIds: [home.id, away.id],
        scoreChanged,
      },
      tickers,
      reason,
    );
  }
}
