import { competitionViewSchema, type CompetitionView } from "@futbolsa/contracts";
import type { ApiClient } from "../../lib/api";

/** A rota da página das competições (item 11 da fila da partida de teste), tipada pelo contrato. Pública. */
export function competitionsApi(api: ApiClient) {
  return {
    /** `GET /competitions/:competition`: a classificação e os jogos da competição na temporada. */
    competition: (competition: CompetitionView["competition"]) => api.request(competitionViewSchema, `/competitions/${competition}`),
  };
}
export type CompetitionsApi = ReturnType<typeof competitionsApi>;
