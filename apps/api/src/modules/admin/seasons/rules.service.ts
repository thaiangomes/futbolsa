import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import {
  ADMIN_ERROR_MESSAGES,
  COMMON_ERROR_MESSAGES,
  type CupCompetitionCode,
  type CupView,
  type PutCupBody,
  type PutSeasonRulesBody,
  type SeasonRulesResponse,
  type SeasonRulesView,
} from "@futbolsa/contracts";
import { validateCupTable } from "@futbolsa/engine";
import { Clock } from "../../../infra/clock/index.js";
import { DB, type Database, lockSeason, type Tx, withTransaction } from "../../../infra/db/index.js";
import { cupPhases, matches, seasonCups, seasonRules, seasons, users } from "../../../infra/db/schema/index.js";
import { CUP_COMPETITIONS } from "../../../infra/db/schema/values.js";
import { DomainError } from "../../../infra/http/index.js";
import { cupFromRows } from "../../dividends/season-values/mapper.js";
import { SeasonValuesService } from "../../dividends/season-values/season-values.service.js";
import { AdminLogService } from "../log/index.js";

/** Fases preliminares não pagam (como em `validateCupTable`): jogo delas sem valor na tabela não é aviso. */
const PRELIMINARY = /^(pre-|preliminar)/i;

const notFound = () => new DomainError("not_found", 404, COMMON_ERROR_MESSAGES.not_found);

/**
 * Valores das ligas e tabela de cada copa da temporada (Dividendos e recompra, critério 28). A tabela que
 * quebra as regras de `validateCupTable` é **aceita**: a API devolve os avisos e a tela os mostra (decisão do
 * Thaian em 2026-10-31). Confirmar grava no registro a lista de avisos que a tela mostrou. Editar uma copa
 * confirmada tira a confirmação dela. Depois da abertura do IPO, nada disto muda (o banco também recusa).
 */
@Injectable()
export class RulesService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly clock: Clock,
    private readonly log: AdminLogService,
    private readonly values: SeasonValuesService,
  ) {}

  /** Os valores e as tabelas. A temporada do seed ainda não tem os dela: ganha na primeira consulta. */
  async get(seasonId: number): Promise<SeasonRulesResponse> {
    return withTransaction(this.db, async (tx) => {
      await this.ensure(tx, seasonId);
      return { rules: await this.rulesView(tx, seasonId), cups: await this.cupViews(tx, seasonId) };
    });
  }

  async putRules(actorId: string, seasonId: number, body: PutSeasonRulesBody): Promise<SeasonRulesView> {
    return withTransaction(this.db, async (tx) => {
      await this.ensureEditable(tx, seasonId);
      const before = await this.rulesView(tx, seasonId);
      const { reason, ...next } = body;
      await tx.db.update(seasonRules).set(next).where(eq(seasonRules.seasonId, seasonId));
      const after = await this.rulesView(tx, seasonId);
      await this.log.record(tx, {
        actorId,
        action: "season.rules.update",
        targetType: "season",
        targetId: String(seasonId),
        before,
        after,
        reason,
      });
      return after;
    });
  }

  async putCup(actorId: string, seasonId: number, competition: CupCompetitionCode, body: PutCupBody): Promise<CupView> {
    return withTransaction(this.db, async (tx) => {
      await this.ensureEditable(tx, seasonId);
      const keys = body.phases.map((p) => `${p.phaseKey}|${p.variant}`);
      if (new Set(keys).size !== keys.length) {
        throw new DomainError("invalid_input", 400, COMMON_ERROR_MESSAGES.invalid_input, ["phases"]);
      }
      // A ordem da fase é a da primeira vez que ela aparece na lista.
      const order = [...new Set(body.phases.map((p) => p.phaseKey))];
      const before = await this.phaseRows(tx, seasonId, competition);
      await tx.db.delete(cupPhases).where(and(eq(cupPhases.seasonId, seasonId), eq(cupPhases.competition, competition)));
      await tx.db.insert(cupPhases).values(
        body.phases.map((p) => ({
          seasonId,
          competition,
          phaseKey: p.phaseKey,
          variant: p.variant,
          ord: order.indexOf(p.phaseKey),
          perShare: p.perShare,
        })),
      );
      // A tabela mudou: a confirmação dela cai.
      await tx.db
        .update(seasonCups)
        .set({ confirmedBy: null, confirmedAt: null })
        .where(and(eq(seasonCups.seasonId, seasonId), eq(seasonCups.competition, competition)));
      const view = await this.cupView(tx, seasonId, competition);
      await this.log.record(tx, {
        actorId,
        action: "cup.update",
        targetType: "cup",
        targetId: competition,
        before: { phases: before },
        after: { phases: view.phases },
        reason: body.reason,
      });
      return view;
    });
  }

  async confirmCup(actorId: string, seasonId: number, competition: CupCompetitionCode): Promise<CupView> {
    return withTransaction(this.db, async (tx) => {
      await this.ensureEditable(tx, seasonId);
      await tx.db
        .update(seasonCups)
        .set({ confirmedBy: actorId, confirmedAt: this.clock.now() })
        .where(and(eq(seasonCups.seasonId, seasonId), eq(seasonCups.competition, competition)));
      const view = await this.cupView(tx, seasonId, competition);
      // O registro guarda os avisos que a tela mostrou ao admin ao confirmar (decisão do Thaian em 2026-10-31).
      await this.log.record(tx, {
        actorId,
        action: "cup.confirm",
        targetType: "cup",
        targetId: competition,
        after: { violations: view.violations },
      });
      return view;
    });
  }

  /** A temporada existe e ganhou os valores iniciais, se ainda não tinha. */
  private async ensure(tx: Tx, seasonId: number): Promise<void> {
    const [exists] = await tx.db.select({ id: seasons.id }).from(seasons).where(eq(seasons.id, seasonId));
    if (!exists) throw notFound();
    await lockSeason(tx, seasonId, "share");
    await this.values.createInitial(tx, seasonId);
  }

  private async ensureEditable(tx: Tx, seasonId: number): Promise<void> {
    await this.ensure(tx, seasonId);
    // Fora da preparação (IPO aberto ou depois) nada muda, mesmo que o `locked_at` não tenha sido gravado
    // (temporada antiga que ganhou os valores só agora, na primeira consulta).
    const [season] = await tx.db.select({ status: seasons.status }).from(seasons).where(eq(seasons.id, seasonId));
    if (season!.status !== "preparing") throw new DomainError("season_locked", 409, ADMIN_ERROR_MESSAGES.season_locked);
    await this.values.assertEditable(tx, seasonId);
  }

  private async rulesView(tx: Tx, seasonId: number): Promise<SeasonRulesView> {
    const [row] = await tx.db.select().from(seasonRules).where(eq(seasonRules.seasonId, seasonId));
    return {
      aPerPoint: row!.aPerPoint,
      bPerPoint: row!.bPerPoint,
      aPlacement: row!.aPlacement,
      promotionPerShare: row!.promotionPerShare,
      promotionSlots: row!.promotionSlots,
      buybackMultipleBp: row!.buybackMultipleBp,
      lockedAt: row!.lockedAt?.toISOString() ?? null,
    };
  }

  private async cupViews(tx: Tx, seasonId: number): Promise<CupView[]> {
    const views: CupView[] = [];
    for (const competition of CUP_COMPETITIONS) views.push(await this.cupView(tx, seasonId, competition));
    return views;
  }

  private async phaseRows(tx: Tx, seasonId: number, competition: CupCompetitionCode) {
    const rows = await tx.db
      .select()
      .from(cupPhases)
      .where(and(eq(cupPhases.seasonId, seasonId), eq(cupPhases.competition, competition)))
      .orderBy(asc(cupPhases.ord), asc(cupPhases.variant));
    return rows.map((r) => ({ phaseKey: r.phaseKey, variant: r.variant, perShare: r.perShare }));
  }

  private async cupView(tx: Tx, seasonId: number, competition: CupCompetitionCode): Promise<CupView> {
    const rows = await tx.db
      .select({ phaseKey: cupPhases.phaseKey, variant: cupPhases.variant, ord: cupPhases.ord, perShare: cupPhases.perShare })
      .from(cupPhases)
      .where(and(eq(cupPhases.seasonId, seasonId), eq(cupPhases.competition, competition)));
    const rules = cupFromRows(rows);
    const [confirmation] = await tx.db
      .select({ at: seasonCups.confirmedAt, nickname: users.nickname })
      .from(seasonCups)
      .leftJoin(users, eq(users.id, seasonCups.confirmedBy))
      .where(and(eq(seasonCups.seasonId, seasonId), eq(seasonCups.competition, competition)));
    const played = await tx.db
      .selectDistinct({ phase: matches.phase })
      .from(matches)
      .where(and(eq(matches.seasonId, seasonId), eq(matches.competition, competition)));
    const known = new Set(rules.phases);
    return {
      competition,
      phases: await this.phaseRows(tx, seasonId, competition),
      violations: validateCupTable(rules).map((v) => ({ code: v.code, message: v.message })),
      phasesWithoutValue: played
        .map((p) => p.phase)
        .filter((p): p is string => !!p && !known.has(p) && !PRELIMINARY.test(p))
        .sort(),
      confirmedBy: confirmation?.at ? (confirmation.nickname ?? null) : null,
      confirmedAt: confirmation?.at?.toISOString() ?? null,
    };
  }
}
