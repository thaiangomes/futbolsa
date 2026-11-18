import { liveGamesSchema } from "@futbolsa/contracts";
import type { ApiClient } from "../../lib/api";

/** A rota dos jogos ao vivo (item 25 da fila da partida de teste), tipada pelo contrato. Pública. */
export function liveGamesApi(api: ApiClient) {
  return {
    /** `GET /live-games`: em andamento, de mais tarde hoje, encerrados hoje e o próximo jogo, com preço e variação do dia. */
    read: () => api.request(liveGamesSchema, "/live-games"),
  };
}
export type LiveGamesApi = ReturnType<typeof liveGamesApi>;
