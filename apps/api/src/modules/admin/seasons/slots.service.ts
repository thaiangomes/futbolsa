import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { ADMIN_ERROR_MESSAGES, type PutSlotsBody, type SlotRulesResponse, type SlotRulesView, slotRulesSchema } from "@futbolsa/contracts";
import { DB, type Database, type DrizzleTx, type Tx, withTransaction } from "../../../infra/db/index.js";
import { seasonRules, seasonSlots } from "../../../infra/db/schema/index.js";
import { DomainError } from "../../../infra/http/index.js";
import { AdminLogService } from "../log/index.js";
import { assertSeasonIdOpen } from "./season-state.js";

/**
 * Regras de vaga para a Libertadores e a Sul-Americana do ano seguinte (Vagas e copas no valor justo dos bots). Só o valor justo
 * dos bots lê; nenhum pagamento depende delas. Antes da abertura do IPO o admin monta pelo `PUT`; depois, só pela correção, com
 * motivo, e o antes e o depois vão para o registro do admin.
 */
@Injectable()
export class SlotsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly log: AdminLogService,
  ) {}

  /** As regras gravadas da temporada, ou `null` (leitura sem transação, para o valor justo dos bots). */
  async read(executor: Database | DrizzleTx, seasonId: number): Promise<SlotRulesView | null> {
    const [row] = await executor.select({ rules: seasonSlots.rules }).from(seasonSlots).where(eq(seasonSlots.seasonId, seasonId));
    if (!row) return null;
    const parsed = slotRulesSchema.safeParse(row.rules);
    return parsed.success ? parsed.data : null;
  }

  async get(seasonId: number): Promise<SlotRulesResponse> {
    const [locked] = await this.db.select({ lockedAt: seasonRules.lockedAt }).from(seasonRules).where(eq(seasonRules.seasonId, seasonId));
    return { slots: await this.read(this.db, seasonId), locked: Boolean(locked?.lockedAt) };
  }

  async put(actorId: string, seasonId: number, body: PutSlotsBody): Promise<SlotRulesResponse> {
    return this.write(actorId, seasonId, body, "season.slots.update", false);
  }

  async correct(actorId: string, seasonId: number, body: PutSlotsBody): Promise<SlotRulesResponse> {
    return this.write(actorId, seasonId, body, "season.slots.correct", true);
  }

  private async write(actorId: string, seasonId: number, body: PutSlotsBody, action: string, correction: boolean): Promise<SlotRulesResponse> {
    return withTransaction(this.db, async (tx: Tx) => {
      await assertSeasonIdOpen(tx, seasonId);
      const [rules] = await tx.db.select({ lockedAt: seasonRules.lockedAt }).from(seasonRules).where(eq(seasonRules.seasonId, seasonId));
      const locked = Boolean(rules?.lockedAt);
      if (!correction && locked) throw new DomainError("season_locked", 409, ADMIN_ERROR_MESSAGES.season_locked);
      if (correction && !locked) throw new DomainError("rules_correction_not_needed", 409, ADMIN_ERROR_MESSAGES.rules_correction_not_needed);
      const before = await this.read(tx.db, seasonId);
      await tx.db
        .insert(seasonSlots)
        .values({ seasonId, rules: body.slots, updatedAt: new Date() })
        .onConflictDoUpdate({ target: seasonSlots.seasonId, set: { rules: body.slots, updatedAt: new Date() } });
      await this.log.record(tx, { actorId, action, targetType: "season", targetId: String(seasonId), before: { slots: before }, after: { slots: body.slots }, reason: body.reason });
      return { slots: body.slots, locked };
    });
  }
}
