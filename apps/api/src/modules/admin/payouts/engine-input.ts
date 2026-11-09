import { Injectable } from "@nestjs/common";
import { asc, eq, inArray } from "drizzle-orm";
import type { EventsInput } from "@futbolsa/engine";
import { type DrizzleTx, Tx } from "../../../infra/db/index.js";
import { clubs, matches, seasonClubs, standings } from "../../../infra/db/schema/index.js";
import { SeasonValuesService } from "../../dividends/season-values/season-values.service.js";
import { toEngineMatch } from "../results/to-engine.js";
import { type Executor, executorOf } from "./holdings.js";

/** As competições com classificação oficial importada (a colocação da Série A e o acesso da Série B). */
export const LEAGUE_COMPETITIONS = ["brasileirao-a", "brasileirao-b"] as const;

const EXTERNAL_PREFIX = "EXT-";

/** O que o fechamento, a prévia, a aprovação e a correção precisam para rodar o motor sobre a temporada. */
export interface SeasonEngineInput {
  /** A entrada de `eventsFor`. */
  input: EventsInput;
  /** O id do clube no motor: o ticker, ou `EXT-<id>` para o clube sem ticker (não listado). */
  tickerOf(clubId: number): string;
  /** O inverso: `PayoutEvent.clubId` (ticker ou `EXT-<id>`) → `clubs.id`. Clube desconhecido é erro. */
  clubIdOf(engineClubId: string): number;
  /**
   * A tabela oficial da competição está conferida pelo admin: tem linhas e todas com `confirmedAt`.
   * Sem isso a colocação e o acesso não são aprovados (`standings_not_confirmed`).
   */
  standingsConfirmed(competition: string): boolean;
}

/**
 * Monta a entrada do motor (`EventsInput`) a partir do banco (Plano dos dividendos e pagamentos, T2):
 * - os jogos da temporada pelo `toEngineMatch` (adiado ou fora da janela vira `postponed`);
 * - a classificação oficial **importada**, na ordem da posição oficial, e não a calculada pelos pontos
 *   (Dividendos e recompra, critério 8: a ordem oficial vale mesmo contra pontos e saldo, porque a fonte aplica
 *   os desempates e as punições do campeonato). Só as competições com linhas; a Série B vem inteira, com os
 *   clubes não listados como `EXT-<id>`, para a posição de cada listado sair certa;
 * - os valores da temporada (`loadSeasonValues`);
 * - os clubes listados (`season_clubs`): só eles recebem.
 */
@Injectable()
export class EngineInputService {
  constructor(private readonly values: SeasonValuesService) {}

  async load(executor: Executor, seasonId: number): Promise<SeasonEngineInput> {
    const db = executorOf(executor);
    const matchRows = await db
      .select()
      .from(matches)
      .where(eq(matches.seasonId, seasonId))
      .orderBy(asc(matches.kickoff), asc(matches.id));
    const standingRows = await db
      .select({
        competition: standings.competition,
        clubId: standings.clubId,
        position: standings.position,
        confirmedAt: standings.confirmedAt,
      })
      .from(standings)
      .where(eq(standings.seasonId, seasonId))
      .orderBy(asc(standings.competition), asc(standings.position), asc(standings.clubId));
    const listedRows = await db.select({ clubId: seasonClubs.clubId }).from(seasonClubs).where(eq(seasonClubs.seasonId, seasonId));

    const clubIds = new Set<number>(listedRows.map((r) => r.clubId));
    for (const m of matchRows) {
      clubIds.add(m.homeClubId);
      clubIds.add(m.awayClubId);
      if (m.advancedClubId !== null) clubIds.add(m.advancedClubId);
    }
    for (const s of standingRows) clubIds.add(s.clubId);
    const clubRows =
      clubIds.size === 0
        ? []
        : await db.select({ id: clubs.id, ticker: clubs.ticker }).from(clubs).where(inArray(clubs.id, [...clubIds]));

    const byId = new Map<number, string>();
    const byEngineId = new Map<string, number>();
    for (const c of clubRows) {
      const engineId = c.ticker ?? `${EXTERNAL_PREFIX}${c.id}`;
      byId.set(c.id, engineId);
      byEngineId.set(engineId, c.id);
    }
    const tickerOf = (clubId: number): string => {
      const engineId = byId.get(clubId);
      if (engineId === undefined) throw new Error(`clube ${clubId} fora da temporada ${seasonId}`);
      return engineId;
    };
    const clubIdOf = (engineClubId: string): number => {
      const id = byEngineId.get(engineClubId);
      if (id === undefined) throw new Error(`clube do motor desconhecido na temporada ${seasonId}: ${engineClubId}`);
      return id;
    };

    const official: Record<string, string[]> = {};
    const confirmed = new Map<string, boolean>();
    const leagues: readonly string[] = LEAGUE_COMPETITIONS;
    for (const s of standingRows) {
      if (!leagues.includes(s.competition)) continue;
      (official[s.competition] ??= []).push(tickerOf(s.clubId));
      confirmed.set(s.competition, (confirmed.get(s.competition) ?? true) && s.confirmedAt !== null);
    }

    // `loadSeasonValues` recebe um `Tx`; fora de transação, um `Tx` em volta do banco serve, porque só lê
    const tx = executor instanceof Tx ? executor : new Tx(db as DrizzleTx);
    const values = await this.values.loadSeasonValues(tx, seasonId);

    return {
      input: {
        matches: matchRows.map((m) => toEngineMatch(m, tickerOf)),
        standings: official,
        values,
        listed: new Set(listedRows.map((r) => tickerOf(r.clubId))),
      },
      tickerOf,
      clubIdOf,
      standingsConfirmed: (competition) => confirmed.get(competition) ?? false,
    };
  }
}
