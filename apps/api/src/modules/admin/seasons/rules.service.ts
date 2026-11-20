import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  ADMIN_ERROR_MESSAGES,
  COMMON_ERROR_MESSAGES,
  type CorrectCupBody,
  type CorrectRulesBody,
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
import { cupPhases, matches, payoutEvents, seasonCups, seasonRules, seasons, users } from "../../../infra/db/schema/index.js";
import { CUP_COMPETITIONS } from "../../../infra/db/schema/values.js";
import { DomainError } from "../../../infra/http/index.js";
import { cupFromRows } from "../../dividends/season-values/mapper.js";
import { SeasonValuesService } from "../../dividends/season-values/season-values.service.js";
import { AdminLogService } from "../log/index.js";
import { assertSeasonIdOpen } from "./season-state.js";

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

  /**
   * Corrige os valores de colocação, classificação e rebaixamento da Série A **depois** da abertura do IPO (a tabela de
   * 2026-11-20 na partida de teste em curso). Só vale enquanto nenhum pagamento de colocação, classificação ou rebaixamento foi
   * aprovado (eles saem no fim do campeonato); os pontos e a recompra não mudam. A exceção à trava do banco vale só dentro desta
   * transação (`futbolsa.rules_correction`), e o antes e o depois vão para o registro do admin, com o motivo. Os eventos
   * pendentes se refazem na próxima passada de fechamento.
   */
  async correctRules(actorId: string, seasonId: number, body: CorrectRulesBody): Promise<SeasonRulesView> {
    return withTransaction(this.db, async (tx) => {
      await assertSeasonIdOpen(tx, seasonId);
      await this.ensure(tx, seasonId);
      const [rules] = await tx.db.select({ lockedAt: seasonRules.lockedAt }).from(seasonRules).where(eq(seasonRules.seasonId, seasonId));
      if (!rules?.lockedAt) throw new DomainError("rules_correction_not_needed", 409, ADMIN_ERROR_MESSAGES.rules_correction_not_needed);
      const [paid] = await tx.db
        .select({ id: payoutEvents.id })
        .from(payoutEvents)
        .where(
          and(
            eq(payoutEvents.seasonId, seasonId),
            eq(payoutEvents.status, "approved"),
            inArray(payoutEvents.kind, ["placement", "qualification", "relegation"]),
          ),
        )
        .limit(1);
      if (paid) throw new DomainError("rules_correction_invalid", 409, ADMIN_ERROR_MESSAGES.rules_correction_invalid);
      const before = await this.rulesView(tx, seasonId);
      const { reason, ...next } = body;
      await tx.db.execute(sql`select set_config('futbolsa.rules_correction', 'on', true)`);
      await tx.db.update(seasonRules).set(next).where(eq(seasonRules.seasonId, seasonId));
      await tx.db.execute(sql`select set_config('futbolsa.rules_correction', 'off', true)`);
      const after = await this.rulesView(tx, seasonId);
      await this.log.record(tx, { actorId, action: "season.rules.correct", targetType: "season", targetId: String(seasonId), before, after, reason });
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

  /**
   * Corrige a tabela de uma copa **depois** da abertura do IPO, para consertar um erro de configuração (item 16 da fila da
   * partida de teste: a Copa do Brasil de 2026 veio sem a 4ª e a 5ª fase). Fase que já tem pagamento (aguardando ou aprovado)
   * fica na tabela com o mesmo valor e na mesma ordem, porque o que foi calculado não pode mudar por baixo; as outras podem ser
   * acrescentadas, ajustadas ou tiradas. A exceção à trava do banco vale só dentro desta
   * transação (`futbolsa.cup_correction`), e o antes e o depois vão para o registro do admin, com o motivo. Os pagamentos das fases
   * novas nascem na próxima passada de fechamento, aguardando aprovação, com a foto das posições no fim de cada fase.
   */
  async correctCup(actorId: string, seasonId: number, competition: CupCompetitionCode, body: CorrectCupBody): Promise<CupView> {
    return withTransaction(this.db, async (tx) => {
      await assertSeasonIdOpen(tx, seasonId);
      await this.ensure(tx, seasonId);
      const [rules] = await tx.db.select({ lockedAt: seasonRules.lockedAt }).from(seasonRules).where(eq(seasonRules.seasonId, seasonId));
      if (!rules?.lockedAt) throw new DomainError("cup_correction_not_needed", 409, ADMIN_ERROR_MESSAGES.cup_correction_not_needed);
      const keys = body.phases.map((p) => `${p.phaseKey}|${p.variant}`);
      if (new Set(keys).size !== keys.length) {
        throw new DomainError("invalid_input", 400, COMMON_ERROR_MESSAGES.invalid_input, ["phases"]);
      }
      const before = await this.phaseRows(tx, seasonId, competition);
      const next = new Map(body.phases.map((p) => [`${p.phaseKey}|${p.variant}`, p.perShare]));
      // as fases com pagamento ficam todas, com o mesmo valor, na mesma ordem relativa
      const paid = await tx.db
        .selectDistinct({ phase: payoutEvents.phase })
        .from(payoutEvents)
        .where(and(eq(payoutEvents.seasonId, seasonId), eq(payoutEvents.competition, competition), ne(payoutEvents.status, "superseded")));
      const withPayout = new Set(paid.map((p) => p.phase));
      const protectedBefore = before.filter((b) => withPayout.has(b.phaseKey));
      const protectedNext = body.phases.filter((p) => withPayout.has(p.phaseKey) && before.some((b) => b.phaseKey === p.phaseKey && b.variant === p.variant));
      const sameOrder = JSON.stringify(protectedNext.map((p) => [p.phaseKey, p.variant])) === JSON.stringify(protectedBefore.map((b) => [b.phaseKey, b.variant]));
      if (protectedBefore.some((b) => next.get(`${b.phaseKey}|${b.variant}`) !== b.perShare) || !sameOrder) {
        throw new DomainError("cup_correction_invalid", 409, ADMIN_ERROR_MESSAGES.cup_correction_invalid);
      }
      const order = [...new Set(body.phases.map((p) => p.phaseKey))];
      await tx.db.execute(sql`select set_config('futbolsa.cup_correction', 'on', true)`);
      await tx.db.delete(cupPhases).where(and(eq(cupPhases.seasonId, seasonId), eq(cupPhases.competition, competition)));
      await tx.db.insert(cupPhases).values(
        body.phases.map((p) => ({ seasonId, competition, phaseKey: p.phaseKey, variant: p.variant, ord: order.indexOf(p.phaseKey), perShare: p.perShare })),
      );
      await tx.db.execute(sql`select set_config('futbolsa.cup_correction', 'off', true)`);
      const view = await this.cupView(tx, seasonId, competition);
      await this.log.record(tx, {
        actorId,
        action: "cup.correct",
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
      // Confirmar com jogos importados em fases sem valor na tabela é recusado (item 16): o pagamento dessas fases não sairia.
      const pending = await this.cupView(tx, seasonId, competition);
      if (pending.phasesWithoutValue.length > 0) {
        throw new DomainError("cup_phases_missing", 409, `${ADMIN_ERROR_MESSAGES.cup_phases_missing} Faltam: ${pending.phasesWithoutValue.join(", ")}.`);
      }
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
    // a temporada encerrada recusa antes de ganhar qualquer valor (F15, T7)
    await assertSeasonIdOpen(tx, seasonId);
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
      aLibertadoresBonus: row!.aLibertadoresBonus,
      aSulamericanaBonus: row!.aSulamericanaBonus,
      aRelegationPenalty: row!.aRelegationPenalty,
      aRelegationSlots: row!.aRelegationSlots,
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
