import { sql } from "drizzle-orm";
import { bigint, check, integer, jsonb, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { futbolsa, instant, money, oneOf } from "./base.js";
import { users } from "./accounts.js";
import { clubs, seasons } from "./admin.js";
import { CUP_COMPETITIONS } from "./values.js";

/**
 * Dono: módulo `dividends` (Dividendos e recompra). Valores da temporada, copiados
 * dos iniciais ao preparar e travados na abertura do IPO (`season_rules.locked_at`;
 * o gatilho da migração 0001 recusa mudar depois).
 */

export const seasonRules = futbolsa.table(
  "season_rules",
  {
    seasonId: integer("season_id")
      .primaryKey()
      .references(() => seasons.id),
    aPerPoint: money("a_per_point").notNull(),
    bPerPoint: money("b_per_point").notNull(),
    /** Colocação final da Série A; índice 0 = 1º lugar, como `BRASILEIRAO_A.placement`. */
    aPlacement: bigint("a_placement", { mode: "number" }).array().notNull(),
    promotionPerShare: money("promotion_per_share").notNull(),
    promotionSlots: integer("promotion_slots").notNull(),
    /** Múltiplo da recompra em pontos-base: 15.000 = 1,5×. */
    buybackMultipleBp: integer("buyback_multiple_bp").notNull().default(15000),
    lockedAt: instant("locked_at"),
  },
  (t) => [
    check(
      "season_rules_values_check",
      sql`${t.aPerPoint} >= 0 and ${t.bPerPoint} >= 0 and ${t.promotionPerShare} >= 0 and ${t.promotionSlots} >= 0 and ${t.buybackMultipleBp} >= 0`,
    ),
    check("season_rules_placement_check", sql`0 <= all(${t.aPlacement})`),
  ],
);

/**
 * Fases que pagam em cada copa da temporada. Espelha o `CupRules` do motor:
 * `variant` = `advance` (passou para a fase seguinte), `to:<fase>` (passou para uma
 * fase específica, como `advanceTo`) ou `title`. `ord` é a ordem da fase.
 */
export const cupPhases = futbolsa.table(
  "cup_phases",
  {
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasons.id),
    competition: text("competition").notNull(),
    phaseKey: text("phase_key").notNull(),
    variant: text("variant").notNull().default("advance"),
    ord: integer("ord").notNull(),
    perShare: money("per_share").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.seasonId, t.competition, t.phaseKey, t.variant] }),
    check("cup_phases_competition_check", oneOf(t.competition, CUP_COMPETITIONS)),
    check("cup_phases_variant_check", sql`${t.variant} in ('advance', 'title') or ${t.variant} like 'to:%'`),
    check("cup_phases_per_share_check", sql`${t.perShare} >= 0`),
  ],
);

/** Quem confirmou a tabela de cada copa e quando. */
export const seasonCups = futbolsa.table(
  "season_cups",
  {
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasons.id),
    competition: text("competition").notNull(),
    confirmedBy: uuid("confirmed_by").references(() => users.id),
    confirmedAt: instant("confirmed_at"),
  },
  (t) => [
    primaryKey({ columns: [t.seasonId, t.competition] }),
    check("season_cups_competition_check", oneOf(t.competition, CUP_COMPETITIONS)),
  ],
);

/**
 * As projeções privadas do jogador (item 20 das melhorias da partida; Livro de ofertas, critérios 54 a 56): as premissas
 * do simulador "Quanto vale para você" por clube, uma por temporada, jogador e clube. Guarda premissas, não um preço:
 * o valor se refaz com os dividendos de cada momento. Nem a casa nem os bots leem esta tabela.
 */
export const clubProjections = futbolsa.table(
  "club_projections",
  {
    seasonId: integer("season_id").notNull().references(() => seasons.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    clubId: integer("club_id").notNull().references(() => clubs.id),
    points: integer("points").notNull(),
    position: integer("position").notNull(),
    /** Por copa, a fase em que o clube cai (ou `campeao`). */
    cups: jsonb("cups").$type<Record<string, string>>().notNull().default({}),
    updatedAt: instant("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.seasonId, t.userId, t.clubId] }),
    check("club_projections_points_check", sql`${t.points} between 0 and 114`),
    check("club_projections_position_check", sql`${t.position} between 1 and 20`),
  ],
);
