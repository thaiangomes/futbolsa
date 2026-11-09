import { Inject, Injectable, Optional } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import {
  ADMIN_ERROR_MESSAGES,
  COMMON_ERROR_MESSAGES,
  type ImportKind,
  type PatchStandingsBody,
  type StandingsCompetition,
  type StandingsView,
} from "@futbolsa/contracts";
import { Clock } from "../../../infra/clock/index.js";
import { DB, type Database, lockSeason, type Tx, withTransaction } from "../../../infra/db/index.js";
import { clubs, standings, users } from "../../../infra/db/schema/index.js";
import { DomainError } from "../../../infra/http/index.js";
import { currentSeason } from "../current-season.js";
import { AdminLogService } from "../log/index.js";
import { resolveClub } from "../results/club-resolver.js";
import type { ImportReport } from "../results/import.service.js";
import type { ResultSource, SourceStanding } from "../results/sources/types.js";
import { StandingsEvents } from "./standings-events.js";

const COMPETITIONS: readonly StandingsCompetition[] = ["brasileirao-a", "brasileirao-b"];

/**
 * A posição que a fonte trouxe fica na coluna `source`, no formato `<fonte>|<posição>`: o banco não tem coluna
 * para ela (a F7 não cria migração) e a tela precisa comparar a ordem do admin com a da fonte.
 */
const encodeSource = (source: string, position: number) => `${source}|${position}`;
function sourcePosition(value: string | null): number | null {
  const n = Number(value?.split("|")[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const noSeason = () => new DomainError("no_season", 409, ADMIN_ERROR_MESSAGES.no_season);
const noTable = () => new DomainError("not_found", 404, COMMON_ERROR_MESSAGES.not_found);

/**
 * Classificação oficial da Série A e da Série B inteira, que a F12 usa para pagar colocação e acesso
 * (Dividendos e recompra). Importada da fonte, conferida e corrigível pelo admin. A importação não pisa em
 * correção manual; quando muda a tabela sem correção, a conferência cai e o admin confere de novo.
 */
@Injectable()
export class StandingsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly clock: Clock,
    private readonly log: AdminLogService,
    @Optional() private readonly events?: StandingsEvents,
  ) {}

  /** Depois do `COMMIT`: a ordem da tabela mudou (a F12 fecha a colocação e o acesso). */
  private notifyChanged(tx: Tx, seasonId: number, competition: StandingsCompetition): void {
    const events = this.events;
    if (events) tx.afterCommit(() => events.publish({ seasonId, competition }));
  }

  /** Busca na fonte (fora de transação) e grava. Fonte fora do ar: lança, e a tabela fica como está. */
  async importFromSource(
    source: ResultSource,
    seasonId: number,
    competition: StandingsCompetition,
    year: number,
  ): Promise<ImportReport> {
    const fetched = await source.fetchStandings(competition, year);
    return this.importStandings(seasonId, competition, fetched, source.id);
  }

  async importStandings(
    seasonId: number,
    competition: StandingsCompetition,
    fetched: readonly SourceStanding[],
    sourceId = "espn",
  ): Promise<ImportReport> {
    const kind: ImportKind = "standings";
    return withTransaction(this.db, async (tx) => {
      const season = await lockSeason(tx, seasonId, "share");
      if (season.status === "closed") throw new DomainError("season_closed", 409, ADMIN_ERROR_MESSAGES.season_closed);

      const report: ImportReport = { competition, kind, inserted: 0, updated: 0, unchanged: 0, clubsCreated: [], error: null };
      const incoming = new Map<number, { position: number; points: number }>();
      for (const row of fetched) {
        const club = await resolveClub(tx, row.clubName);
        if (club.created) report.clubsCreated.push(club.name);
        incoming.set(club.id, { position: row.position, points: row.points });
      }
      // Trava a tabela (na mesma ordem da correção): a correção do admin em curso termina antes, e a
      // importação vê o `manual_override` dela em vez de apagar a ordem corrigida.
      const existing = await tx.db
        .select()
        .from(standings)
        .where(and(eq(standings.seasonId, seasonId), eq(standings.competition, competition)))
        .orderBy(asc(standings.position))
        .for("update");
      const manual = existing.some((r) => r.manualOverride);

      if (manual) {
        // O admin corrigiu: a ordem dele fica. Só os pontos e a posição da fonte (para a tela comparar) mudam.
        const byClub = new Map(existing.map((r) => [r.clubId, r]));
        for (const [clubId, data] of incoming) {
          const row = byClub.get(clubId);
          if (!row) continue;
          await tx.db
            .update(standings)
            .set({ points: data.points, source: encodeSource(sourceId, data.position) })
            .where(and(eq(standings.seasonId, seasonId), eq(standings.competition, competition), eq(standings.clubId, clubId)));
        }
        report.unchanged = existing.length;
        return report;
      }

      const same =
        existing.length === incoming.size &&
        existing.every((r) => {
          const n = incoming.get(r.clubId);
          return n && n.position === r.position && n.points === r.points;
        });
      if (same) {
        report.unchanged = existing.length;
        return report;
      }
      // A fonte mudou a tabela e ninguém corrigiu: troca tudo e a conferência cai.
      const known = new Set(existing.map((r) => r.clubId));
      report.updated = existing.filter((r) => incoming.has(r.clubId)).length;
      report.inserted = [...incoming.keys()].filter((id) => !known.has(id)).length;
      await tx.db.delete(standings).where(and(eq(standings.seasonId, seasonId), eq(standings.competition, competition)));
      if (incoming.size > 0) {
        await tx.db.insert(standings).values(
          [...incoming].map(([clubId, d]) => ({
            seasonId,
            competition,
            clubId,
            position: d.position,
            points: d.points,
            source: encodeSource(sourceId, d.position),
            manualOverride: false,
            updatedAt: this.clock.now(),
          })),
        );
      }
      this.notifyChanged(tx, seasonId, competition);
      return report;
    });
  }

  /** As duas tabelas, para a tela; sem temporada ou sem importação, as linhas vêm vazias. */
  async list(): Promise<StandingsView[]> {
    const season = await currentSeason(this.db);
    return Promise.all(COMPETITIONS.map((competition) => this.view(this.db, season?.id ?? null, competition)));
  }

  async correct(actorId: string, competition: StandingsCompetition, body: PatchStandingsBody): Promise<StandingsView> {
    return withTransaction(this.db, async (tx) => {
      const seasonId = await this.lockCurrent(tx);
      const rows = await tx.db
        .select()
        .from(standings)
        .where(and(eq(standings.seasonId, seasonId), eq(standings.competition, competition)))
        .orderBy(asc(standings.position))
        .for("update");
      if (rows.length === 0) throw noTable();
      const ids = new Set(rows.map((r) => r.clubId));
      const order = body.order;
      if (order.length !== ids.size || new Set(order).size !== order.length || order.some((id) => !ids.has(id))) {
        // A ordem tem de trazer exatamente os clubes da tabela, cada um uma vez.
        throw new DomainError("invalid_input", 400, COMMON_ERROR_MESSAGES.invalid_input, ["order"]);
      }
      const before = rows.map((r) => r.clubId);
      for (const [i, clubId] of order.entries()) {
        await tx.db
          .update(standings)
          .set({
            position: i + 1,
            manualOverride: true,
            confirmedBy: null,
            confirmedAt: null,
            updatedAt: this.clock.now(),
          })
          .where(and(eq(standings.seasonId, seasonId), eq(standings.competition, competition), eq(standings.clubId, clubId)));
      }
      await this.log.record(tx, {
        actorId,
        action: "standings.update",
        targetType: "standings",
        targetId: competition,
        before: { order: before },
        after: { order },
        reason: body.reason,
      });
      this.notifyChanged(tx, seasonId, competition);
      return this.view(tx.db, seasonId, competition);
    });
  }

  async confirm(actorId: string, competition: StandingsCompetition): Promise<StandingsView> {
    return withTransaction(this.db, async (tx) => {
      const seasonId = await this.lockCurrent(tx);
      const rows = await tx.db
        .select()
        .from(standings)
        .where(and(eq(standings.seasonId, seasonId), eq(standings.competition, competition)))
        .for("update");
      if (rows.length === 0) throw noTable();
      await tx.db
        .update(standings)
        .set({ confirmedBy: actorId, confirmedAt: this.clock.now() })
        .where(and(eq(standings.seasonId, seasonId), eq(standings.competition, competition)));
      await this.log.record(tx, {
        actorId,
        action: "standings.confirm",
        targetType: "standings",
        targetId: competition,
        after: { clubs: rows.length },
      });
      return this.view(tx.db, seasonId, competition);
    });
  }

  private async lockCurrent(tx: Tx): Promise<number> {
    const season = await currentSeason(tx.db);
    if (!season) throw noSeason();
    await lockSeason(tx, season.id, "share");
    return season.id;
  }

  private async view(db: Database | Tx["db"], seasonId: number | null, competition: StandingsCompetition): Promise<StandingsView> {
    const empty: StandingsView = { competition, rows: [], manualOverride: false, confirmedBy: null, confirmedAt: null };
    if (seasonId === null) return empty;
    const rows = await db
      .select({ s: standings, club: clubs, nickname: users.nickname })
      .from(standings)
      .innerJoin(clubs, eq(clubs.id, standings.clubId))
      .leftJoin(users, eq(users.id, standings.confirmedBy))
      .where(and(eq(standings.seasonId, seasonId), eq(standings.competition, competition)))
      .orderBy(asc(standings.position));
    if (rows.length === 0) return empty;
    // Confirmada é a tabela em que todas as linhas têm conferência.
    const confirmed = rows.every((r) => r.s.confirmedAt !== null);
    return {
      competition,
      rows: rows.map((r) => ({
        club: { id: r.club.id, ticker: r.club.ticker, name: r.club.name },
        position: r.s.position,
        points: r.s.points,
        sourcePosition: sourcePosition(r.s.source),
      })),
      manualOverride: rows.some((r) => r.s.manualOverride),
      confirmedBy: confirmed ? (rows[0]!.nickname ?? null) : null,
      confirmedAt: confirmed ? rows[0]!.s.confirmedAt!.toISOString() : null,
    };
  }
}
