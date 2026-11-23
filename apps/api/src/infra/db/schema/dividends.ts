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
    /** Bônus por ação de quem vai à Libertadores e à Sul-Americana (o admin marca os classificados; zero = sem bônus). */
    aLibertadoresBonus: money("a_libertadores_bonus").notNull().default(0),
    aSulamericanaBonus: money("a_sulamericana_bonus").notNull().default(0),
    /** Penalização por ação dos rebaixados (debitada do caixa no fechamento) e quantos últimos colocados pagam. */
    aRelegationPenalty: money("a_relegation_penalty").notNull().default(0),
    aRelegationSlots: integer("a_relegation_slots").notNull().default(0),
    promotionPerShare: money("promotion_per_share").notNull(),
    promotionSlots: integer("promotion_slots").notNull(),
    /** Múltiplo da recompra em pontos-base: 15.000 = 1,5×. */
    buybackMultipleBp: integer("buyback_multiple_bp").notNull().default(15000),
    lockedAt: instant("locked_at"),
  },
  (t) => [
    check(
      "season_rules_values_check",
      sql`${t.aPerPoint} >= 0 and ${t.bPerPoint} >= 0 and ${t.promotionPerShare} >= 0 and ${t.promotionSlots} >= 0 and ${t.buybackMultipleBp} >= 0 and ${t.aLibertadoresBonus} >= 0 and ${t.aSulamericanaBonus} >= 0 and ${t.aRelegationPenalty} >= 0 and ${t.aRelegationSlots} between 0 and 20`,
    ),
    check("season_rules_placement_check", sql`0 <= all(${t.aPlacement})`),
  ],
);

/**
 * As regras de vaga para a Libertadores e a Sul-Americana do ano seguinte (Vagas e copas no valor justo dos bots): as vagas da
 * tabela e as rotas pelas copas de cada destino, em JSON no formato do motor (`SlotRules`). Só o valor justo dos bots lê;
 * nenhum pagamento depende dela (a marcação dos classificados continua do admin). Antes do IPO o admin edita; depois, só pela
 * rota de correção, com motivo. Sem linha, os bots usam as seis vagas da tabela de cada destino.
 */
export const seasonSlots = futbolsa.table("season_slots", {
  seasonId: integer("season_id")
    .primaryKey()
    .references(() => seasons.id),
  rules: jsonb("rules").notNull(),
  updatedAt: instant("updated_at").notNull().default(sql`now()`),
});

/**
 * Os classificados da Série A para o ano seguinte, marcados pelo admin no fechamento (Dividendos e recompra, "Classificação
 * para o ano seguinte"): um clube pode estar nas duas listas e então recebe só o bônus da Libertadores. Fora da trava dos
 * valores: a marcação acontece depois da abertura do IPO.
 */
export const seasonQualifications = futbolsa.table(
  "season_qualifications",
  {
    seasonId: integer("season_id")
      .notNull()
      .references(() => seasons.id),
    clubId: integer("club_id")
      .notNull()
      .references(() => clubs.id),
    cup: text("cup").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.seasonId, t.clubId, t.cup] }),
    check("season_qualifications_cup_check", sql`${t.cup} in ('libertadores', 'sulamericana')`),
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
