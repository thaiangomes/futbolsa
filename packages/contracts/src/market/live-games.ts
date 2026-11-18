import { z } from "zod";
import { FIXTURE_COMPETITIONS } from "./fixtures.js";

/**
 * Os jogos ao vivo (item 25 da fila da partida de teste): `GET /live-games`, que alimenta a faixa do topo de todas as telas e a
 * página dos jogos ao vivo. Pública. Cada time traz o preço do último negócio e a variação do dia (desde as 0h de Brasília),
 * como a lista do Mercado. O placar e o minuto parciais vêm da fonte de resultados e podem estar até 5 minutos atrasados; sem
 * eles o jogo em andamento segue na lista, com `score` nulo. Nada da casa: gol não paga dividendo, só o resultado final.
 */

/** Um time do jogo. Clube que não é listado na temporada vem sem ticker, preço e variação. */
export const liveGameSideSchema = z.strictObject({
  ticker: z.string().nullable(),
  name: z.string(),
  /** O preço exibido (o último negócio), em centavos. */
  price: z.number().int().nullable(),
  /** Variação do dia em centésimos de ponto percentual (+3,02% = 302). */
  changeBp: z.number().int().nullable(),
});
export type LiveGameSide = z.infer<typeof liveGameSideSchema>;

export const liveGameSchema = z.strictObject({
  competition: z.enum(FIXTURE_COMPETITIONS),
  round: z.number().int().nullable(),
  phase: z.string().nullable(),
  /** O horário marcado do jogo (ISO, UTC). */
  kickoff: z.string(),
  /** O minuto de jogo (0 a 90, 45 no intervalo); `null` fora do jogo em andamento ou sem como saber. */
  minute: z.number().int().nullable(),
  /** O placar de agora (jogo em andamento) ou o final (encerrado); `null` antes do jogo e sem placar parcial. */
  score: z.strictObject({ home: z.number().int(), away: z.number().int() }).nullable(),
  home: liveGameSideSchema,
  away: liveGameSideSchema,
});
export type LiveGame = z.infer<typeof liveGameSchema>;

export const liveGamesSchema = z.strictObject({
  /** Em andamento agora, pelo horário de início. */
  live: z.array(liveGameSchema),
  /** Ainda vão começar hoje (dia de Brasília). */
  upcoming: z.array(liveGameSchema),
  /** Encerrados hoje, o mais recente primeiro. */
  finished: z.array(liveGameSchema),
  /** O próximo jogo agendado da temporada (para a página sem jogo em andamento); `null` sem jogo marcado. */
  next: liveGameSchema.nullable(),
});
export type LiveGames = z.infer<typeof liveGamesSchema>;
