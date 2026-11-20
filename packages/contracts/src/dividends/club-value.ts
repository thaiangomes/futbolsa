import { z } from "zod";

/**
 * `GET /clubs/:ticker/dividends` (F12, T12): o que a tela do clube precisa para o cartão "Quanto vale para você" e o
 * simulador (Livro de ofertas e formador de mercado, critério 38): o que a ação já pagou e tem a receber, os pontos e a
 * fase atual de cada copa, e os valores fixos da temporada. Rota pública. O cálculo roda no navegador, com a mesma função
 * do motor (`clubValue`). **Nunca** leva o valor justo da casa nem as projeções dela: só dado público e a regra da temporada.
 */

export const CLUB_VALUE_CUPS = ["copa-do-brasil", "libertadores", "sulamericana"] as const;

const centsSchema = z.number().int().nonnegative();

/** Uma copa que o clube disputa na temporada: as fases que pagam (`CupRules` do motor) e onde ele está agora. */
export const clubValueCupSchema = z.strictObject({
  competition: z.enum(CLUB_VALUE_CUPS),
  /** As fases em ordem, da primeira à final. */
  phases: z.array(z.string()),
  /** Quanto paga passar de cada fase (a chave é a fase da qual o clube sai). */
  advance: z.record(z.string(), centsSchema),
  /** Valor diferente conforme a fase de destino (Sul-Americana: grupos → playoffs). */
  advanceTo: z.record(z.string(), z.record(z.string(), centsSchema)).optional(),
  title: centsSchema,
  /** A fase em que o clube está; `null` quando já caiu ou a copa acabou para ele. */
  currentPhase: z.string().nullable(),
  /** A situação do clube na copa: disputando, eliminado ou campeão (com `currentPhase` nulo, o clube já saiu dela). */
  outcome: z.enum(["playing", "eliminated", "champion"]),
});
export type ClubValueCup = z.infer<typeof clubValueCupSchema>;

export const clubValueViewSchema = z.strictObject({
  ticker: z.string(),
  /** `brasileirao-a` ou `brasileirao-b`, o campeonato do clube nesta temporada. */
  league: z.enum(["brasileirao-a", "brasileirao-b"]),
  /** Valor de cada ponto e tabela de colocação (índice 0 = 1º lugar) do campeonato. */
  leagueRules: z.strictObject({
    perPoint: centsSchema,
    placement: z.array(centsSchema),
    /** Bônus de classificação projetado (Libertadores do 1º ao 6º, Sul-Americana do 7º ao 12º) e penalização por colocação, quando a temporada os tem. */
    qualification: z.strictObject({ libertadores: centsSchema, sulamericana: centsSchema }).optional(),
    penalty: z.array(centsSchema).optional(),
  }),
  /** Falso quando o campeonato já fechou (colocação paga): a aposta em pontos e colocação não vale mais. */
  leagueOpen: z.boolean(),
  /** Pontos e colocação agora (0 e `null` antes da primeira rodada). */
  points: z.number().int().nonnegative(),
  position: z.number().int().positive().nullable(),
  /** Jogos já disputados no campeonato. */
  played: z.number().int().nonnegative(),
  /** Dividendos por ação já pagos (aprovados) e a receber (fechados, ainda sem aprovação), em centavos. */
  paid: centsSchema,
  toReceive: centsSchema,
  /** Múltiplo da recompra em pontos-base: 15.000 = 1,5×. */
  buybackMultipleBp: z.number().int().nonnegative(),
  /** Só as copas que o clube disputa na temporada. */
  cups: z.array(clubValueCupSchema),
});
export type ClubValueView = z.infer<typeof clubValueViewSchema>;
