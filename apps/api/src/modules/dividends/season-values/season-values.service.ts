import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { ADMIN_ERROR_MESSAGES } from "@futbolsa/contracts";
import type { SeasonValues } from "@futbolsa/engine";
import { DB, type Database, type DrizzleTx, type Tx } from "../../../infra/db/index.js";
import { cupPhases, seasonCups, seasonRules, seasons } from "../../../infra/db/schema/index.js";
import { CUP_COMPETITIONS } from "../../../infra/db/schema/values.js";
import { DomainError } from "../../../infra/http/index.js";
import { type CupCompetition, INITIAL_CUPS, initialRules } from "./defaults.js";
import { type CupPhaseRow, cupFromRows, cupToRows, leaguesFromRules, type RulesRow } from "./mapper.js";

/**
 * Os valores de dividendos de uma temporada (Dividendos e recompra, critério 28): copiados dos da temporada
 * anterior (ou das constantes do motor, na primeira) ao preparar, editados pelo admin e travados na abertura do
 * IPO (`season_rules.locked_at`; o gatilho do banco recusa mudar depois). A F8 usa `assertCupsConfirmed` e
 * `lockSeasonValues`; a F9 e a F12 leem com `loadSeasonValues`.
 */
@Injectable()
export class SeasonValuesService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * Grava os valores da temporada: cópia da anterior com valores, ou as constantes do motor. As tabelas das
   * copas começam não confirmadas, mesmo que a anterior estivesse. Devolve `false` se a temporada já tinha os dela.
   */
  async createInitial(tx: Tx, seasonId: number): Promise<boolean> {
    const [already] = await tx.db.select({ id: seasonRules.seasonId }).from(seasonRules).where(eq(seasonRules.seasonId, seasonId));
    if (already) return false;
    const [season] = await tx.db.select({ year: seasons.year }).from(seasons).where(eq(seasons.id, seasonId));
    if (!season) throw new Error(`temporada inexistente: ${seasonId}`);
    const [previous] = await tx.db
      .select({ seasonId: seasonRules.seasonId })
      .from(seasonRules)
      .innerJoin(seasons, eq(seasons.id, seasonRules.seasonId))
      .where(lt(seasons.year, season.year))
      .orderBy(desc(seasons.year))
      .limit(1);

    let rules: RulesRow = initialRules();
    const cups = new Map<CupCompetition, CupPhaseRow[]>(
      CUP_COMPETITIONS.map((c) => [c, cupToRows(INITIAL_CUPS[c])]),
    );
    if (previous) {
      rules = await this.rulesOf(tx.db, previous.seasonId);
      const rows = await tx.db.select().from(cupPhases).where(eq(cupPhases.seasonId, previous.seasonId));
      for (const competition of CUP_COMPETITIONS) {
        const own = rows.filter((r) => r.competition === competition);
        if (own.length > 0) cups.set(competition, own);
      }
    }
    await tx.db.insert(seasonRules).values({ seasonId, ...rules });
    for (const [competition, rows] of cups) {
      await tx.db.insert(cupPhases).values(
        rows.map((r) => ({ seasonId, competition, phaseKey: r.phaseKey, variant: r.variant, ord: r.ord, perShare: r.perShare })),
      );
      await tx.db.insert(seasonCups).values({ seasonId, competition });
    }
    return true;
  }

  /** Os valores da temporada no formato do motor (`SeasonValues`). */
  async loadSeasonValues(tx: Tx, seasonId: number): Promise<SeasonValues> {
    const rules = await this.rulesOf(tx.db, seasonId);
    const rows = await tx.db.select().from(cupPhases).where(eq(cupPhases.seasonId, seasonId));
    const cups = Object.fromEntries(
      CUP_COMPETITIONS.map((competition) => [competition, cupFromRows(rows.filter((r) => r.competition === competition))]),
    );
    return { leagues: leaguesFromRules(rules), cups };
  }

  /** Abrir o IPO sem a tabela das três copas confirmada é recusado (a F8 chama antes de abrir). */
  async assertCupsConfirmed(seasonId: number, executor: Database | DrizzleTx = this.db): Promise<void> {
    const rows = await executor.select().from(seasonCups).where(eq(seasonCups.seasonId, seasonId));
    const confirmed = new Set(rows.filter((r) => r.confirmedAt !== null).map((r) => r.competition));
    if (CUP_COMPETITIONS.some((c) => !confirmed.has(c))) {
      throw new DomainError("cups_not_confirmed", 409, ADMIN_ERROR_MESSAGES.cups_not_confirmed);
    }
  }

  /** Recusa mudar os valores depois da abertura do IPO (o banco também recusa). */
  async assertEditable(tx: Tx, seasonId: number): Promise<void> {
    const [rules] = await tx.db.select({ lockedAt: seasonRules.lockedAt }).from(seasonRules).where(eq(seasonRules.seasonId, seasonId));
    if (!rules) throw new Error(`temporada sem valores: ${seasonId}`);
    if (rules.lockedAt) throw new DomainError("season_locked", 409, ADMIN_ERROR_MESSAGES.season_locked);
  }

  /** Trava os valores na abertura do IPO. Travar de novo não muda a hora. */
  async lockSeasonValues(tx: Tx, seasonId: number, at: Date): Promise<void> {
    await tx.db
      .update(seasonRules)
      .set({ lockedAt: at })
      .where(and(eq(seasonRules.seasonId, seasonId), isNull(seasonRules.lockedAt)));
  }

  private async rulesOf(db: DrizzleTx | Database, seasonId: number): Promise<RulesRow> {
    const [row] = await db.select().from(seasonRules).where(eq(seasonRules.seasonId, seasonId));
    if (!row) throw new Error(`temporada sem valores: ${seasonId}`);
    return {
      aPerPoint: row.aPerPoint,
      bPerPoint: row.bPerPoint,
      aPlacement: row.aPlacement,
      promotionPerShare: row.promotionPerShare,
      promotionSlots: row.promotionSlots,
      buybackMultipleBp: row.buybackMultipleBp,
    };
  }
}
