import { z } from "zod";

/**
 * Os próximos jogos de um clube (item 9 da fila da partida de teste): `GET /clubs/:ticker/fixtures` e o `nextMatch` de cada
 * item de `GET /clubs`. Pública. Só jogos agendados, com dados que o calendário já mostra a todos: nada da casa.
 */

export const FIXTURE_COMPETITIONS = ["brasileirao-a", "brasileirao-b", "copa-do-brasil", "libertadores", "sulamericana"] as const;

/** O adversário: o ticker quando o clube é listado na temporada (para o selo), e sempre o nome. */
export const fixtureOpponentSchema = z.strictObject({
  ticker: z.string().nullable(),
  name: z.string(),
});

export const fixtureSchema = z.strictObject({
  /** O horário marcado do jogo (ISO, UTC); a tela mostra o de Brasília. */
  kickoff: z.string(),
  competition: z.enum(FIXTURE_COMPETITIONS),
  /** A rodada (campeonatos) ou a fase (copas): um dos dois, conforme a competição. */
  round: z.number().int().nullable(),
  phase: z.string().nullable(),
  /** O clube joga em casa. */
  home: z.boolean(),
  opponent: fixtureOpponentSchema,
  /** O jogo já começou e o placar ainda não chegou ("em jogo agora"). */
  inPlay: z.boolean(),
});
export type Fixture = z.infer<typeof fixtureSchema>;

export const clubFixturesSchema = z.strictObject({
  ticker: z.string(),
  fixtures: z.array(fixtureSchema),
});
export type ClubFixtures = z.infer<typeof clubFixturesSchema>;
