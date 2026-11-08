import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { ADMIN_ERROR_MESSAGES, type CompetitionCode, type ImportKind } from "@futbolsa/contracts";
import { markOutOfWindow } from "@futbolsa/engine";
import { Clock } from "../../../infra/clock/index.js";
import { DB, type Database, lockSeason, type Tx, withTransaction } from "../../../infra/db/index.js";
import { matches } from "../../../infra/db/schema/index.js";
import { DomainError } from "../../../infra/http/index.js";
import { resolveClub, type ResolvedClub } from "./club-resolver.js";
import { MarketPort, MatchesEvents, notifyAfterCommit } from "./ports.js";
import type { ResultSource, SourceMatch } from "./sources/types.js";
import { type MatchRow, toEngineMatch } from "./to-engine.js";

export interface ImportReport {
  competition: CompetitionCode;
  kind: ImportKind;
  inserted: number;
  updated: number;
  unchanged: number;
  /** Clubes que a importação criou sem ticker (podem ser duplicados de outro nome). */
  clubsCreated: string[];
  error: string | null;
}

/** O que a fonte disse por último sobre o jogo, guardado em `source_snapshot` (e mostrado na divergência). */
export interface SourceSnapshot {
  status: SourceMatch["status"];
  homeGoals: number | null;
  awayGoals: number | null;
  kickoff: string;
  fetchedAt: string;
}

const snapshotOf = (m: SourceMatch, fetchedAt: Date): SourceSnapshot => ({
  status: m.status,
  homeGoals: m.homeGoals,
  awayGoals: m.awayGoals,
  kickoff: m.kickoff.toISOString(),
  fetchedAt: fetchedAt.toISOString(),
});

/**
 * Importação de jogos sem pisar no admin (Admin, critérios 6 e 7). A chamada à fonte acontece fora de
 * qualquer transação; só a gravação, curta, abre uma. O que o admin escreveu vale mais que a fonte:
 * um jogo com `manual_override` só atualiza o `source_snapshot`.
 */
@Injectable()
export class ImportService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly clock: Clock,
    private readonly events: MatchesEvents,
    private readonly market: MarketPort,
  ) {}

  /** Busca na fonte (fora de transação) e grava. Fonte fora do ar: lança, e nada é apagado nem alterado. */
  async importFromSource(
    source: ResultSource,
    seasonId: number,
    competition: CompetitionCode,
    year: number,
    options: { range?: { from: Date; to: Date }; kind?: ImportKind } = {},
  ): Promise<ImportReport> {
    const fetched = await source.fetchMatches(competition, year, options.range);
    return this.importMatches(seasonId, competition, fetched, options.kind ?? "calendar");
  }

  async importMatches(
    seasonId: number,
    competition: CompetitionCode,
    fetched: readonly SourceMatch[],
    kind: ImportKind = "calendar",
  ): Promise<ImportReport> {
    const fetchedAt = this.clock.now();
    return withTransaction(this.db, async (tx) => {
      const season = await lockSeason(tx, seasonId, "share");
      if (season.status === "closed") {
        throw new DomainError("season_closed", 409, ADMIN_ERROR_MESSAGES.season_closed);
      }

      const report: ImportReport = { competition, kind, inserted: 0, updated: 0, unchanged: 0, clubsCreated: [], error: null };
      const clubsByName = new Map<string, ResolvedClub>();
      for (const name of new Set(fetched.flatMap((m) => [m.homeName, m.awayName]))) {
        const club = await resolveClub(tx, name);
        clubsByName.set(name, club);
        if (club.created) report.clubsCreated.push(club.name);
      }
      const tickerOfClub = new Map<number, string | null>([...clubsByName.values()].map((c) => [c.id, c.ticker]));

      const existing = await tx.db
        .select()
        .from(matches)
        .where(and(eq(matches.seasonId, seasonId), eq(matches.competition, competition)));
      const byKey = new Map(existing.filter((m) => m.source && m.sourceId).map((m) => [`${m.source}:${m.sourceId}`, m]));
      const unlinkedManual = existing.filter((m) => m.source === "manual" && !m.sourceId);

      const changedIds = new Set<number>();
      const changedClubs = new Set<number>();
      const scoreClubs = new Set<number>();

      for (const src of fetched) {
        const home = clubsByName.get(src.homeName)!;
        const away = clubsByName.get(src.awayName)!;
        const snapshot = snapshotOf(src, fetchedAt);
        const advancedClubId = src.advancedName ? (clubsByName.get(src.advancedName)?.id ?? null) : null;
        const data = {
          round: src.round,
          phase: src.phase,
          homeClubId: home.id,
          awayClubId: away.id,
          kickoff: src.kickoff,
          status: src.status,
          homeGoals: src.homeGoals,
          awayGoals: src.awayGoals,
          advancedClubId,
        };

        const known = byKey.get(`${src.source}:${src.sourceId}`);
        if (known) {
          if (known.manualOverride) {
            // O que o admin escreveu vale mais: só o snapshot muda, e a tela mostra a divergência.
            await tx.db.update(matches).set({ sourceSnapshot: snapshot }).where(eq(matches.id, known.id));
            report.unchanged++;
            continue;
          }
          const sameData = sameMatchData(known, data);
          await tx.db
            .update(matches)
            .set(sameData ? { sourceSnapshot: snapshot } : { ...data, sourceSnapshot: snapshot, updatedAt: fetchedAt })
            .where(and(eq(matches.id, known.id), eq(matches.manualOverride, false)));
          if (sameData) {
            report.unchanged++;
            continue;
          }
          report.updated++;
          changedIds.add(known.id);
          for (const c of [home.id, away.id]) changedClubs.add(c);
          if (scoreDiffers(known, data)) for (const c of [home.id, away.id]) scoreClubs.add(c);
          continue;
        }

        // Jogo cadastrado à mão que a fonte passa a trazer: liga ao da fonte em vez de duplicar.
        const manual = unlinkedManual.find(
          (m) =>
            m.homeClubId === home.id &&
            m.awayClubId === away.id &&
            (src.round !== null ? m.round === src.round : m.phase === src.phase),
        );
        if (manual) {
          unlinkedManual.splice(unlinkedManual.indexOf(manual), 1);
          await tx.db
            .update(matches)
            .set({ source: src.source, sourceId: src.sourceId, sourceSnapshot: snapshot })
            .where(eq(matches.id, manual.id));
          report.updated++;
          continue;
        }

        const [inserted] = await tx.db
          .insert(matches)
          .values({ seasonId, competition, ...data, source: src.source, sourceId: src.sourceId, sourceSnapshot: snapshot, updatedAt: fetchedAt })
          .returning({ id: matches.id });
        report.inserted++;
        changedIds.add(inserted!.id);
        for (const c of [home.id, away.id]) changedClubs.add(c);
        if (src.status === "finished") for (const c of [home.id, away.id]) scoreClubs.add(c);
      }

      for (const id of await this.recomputeOutOfWindow(tx, seasonId, competition, tickerOfClub)) {
        changedIds.add(id);
      }

      if (changedIds.size > 0) {
        const tickers = [...scoreClubs].map((id) => tickerOfClub.get(id)).filter((t): t is string => !!t);
        const event = {
          seasonId,
          competition,
          matchIds: [...changedIds],
          clubIds: [...changedClubs],
          scoreChanged: scoreClubs.size > 0,
        };
        notifyAfterCommit(tx, { db: this.db, events: this.events, market: this.market }, event, tickers);
      }
      return report;
    });
  }

  /**
   * Recalcula `out_of_window` pela regra de `markOutOfWindow` (mediana da rodada, 3 dias) sobre os jogos
   * da competição. Só grava nos jogos sem `manual_override`; devolve os ids que mudaram.
   */
  private async recomputeOutOfWindow(
    tx: Tx,
    seasonId: number,
    competition: CompetitionCode,
    tickers: ReadonlyMap<number, string | null>,
  ): Promise<number[]> {
    const rows = await tx.db
      .select()
      .from(matches)
      .where(and(eq(matches.seasonId, seasonId), eq(matches.competition, competition)));
    // `markOutOfWindow` só olha data e rodada; o clube entra aqui só para montar o jogo do motor.
    const engine = markOutOfWindow(rows.filter((r) => r.round !== null).map((r) => toEngineMatch({ ...r, outOfWindow: false, status: "scheduled" }, (id) => tickers.get(id) ?? `EXT-${id}`)));
    const computed = new Map(engine.map((m) => [Number(m.id), m.postponed === true]));
    const changed: number[] = [];
    for (const row of rows) {
      if (row.manualOverride || row.round === null) continue;
      const wanted = computed.get(row.id) ?? false;
      if (row.outOfWindow === wanted) continue;
      await tx.db.update(matches).set({ outOfWindow: wanted }).where(eq(matches.id, row.id));
      changed.push(row.id);
    }
    return changed;
  }
}

type MatchData = Pick<MatchRow, "round" | "phase" | "homeClubId" | "awayClubId" | "kickoff" | "status" | "homeGoals" | "awayGoals" | "advancedClubId">;

function sameMatchData(a: MatchRow, b: MatchData): boolean {
  return (
    a.round === b.round &&
    a.phase === b.phase &&
    a.homeClubId === b.homeClubId &&
    a.awayClubId === b.awayClubId &&
    a.kickoff.getTime() === b.kickoff.getTime() &&
    a.status === b.status &&
    a.homeGoals === b.homeGoals &&
    a.awayGoals === b.awayGoals &&
    a.advancedClubId === b.advancedClubId
  );
}

/** Um placar entrou ou mudou (e não só uma data ou o estado). */
function scoreDiffers(a: MatchRow, b: MatchData): boolean {
  return a.homeGoals !== b.homeGoals || a.awayGoals !== b.awayGoals || (a.status !== b.status && (a.status === "finished" || b.status === "finished"));
}
