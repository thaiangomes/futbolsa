import { liveRankingSchema, officialRankingSchema, rankingHistorySchema, type RankingPeriodName } from "@futbolsa/contracts";
import type { ApiClient } from "../../lib/api";

/** As rotas dos rankings (F13), tipadas pelos contratos. Todas públicas; com login, a parcial traz também a linha do jogador. */
export function rankingsApi(api: ApiClient) {
  return {
    /** `GET /rankings/live`: a parcial do mês ou da temporada. */
    live: (period: RankingPeriodName, offset = 0, limit = 50) => api.request(liveRankingSchema, `/rankings/live?period=${period}&offset=${offset}&limit=${limit}`),
    /** `GET /rankings/month/:yyyy-mm`. */
    month: (key: string, offset = 0, limit = 50) => api.request(officialRankingSchema, `/rankings/month/${encodeURIComponent(key)}?offset=${offset}&limit=${limit}`),
    /** `GET /rankings/season/:ano`. */
    season: (year: string, offset = 0, limit = 50) => api.request(officialRankingSchema, `/rankings/season/${encodeURIComponent(year)}?offset=${offset}&limit=${limit}`),
    /** `GET /rankings/history`: temporadas, meses fechados e campeões. */
    history: () => api.request(rankingHistorySchema, "/rankings/history"),
  };
}
export type RankingsApi = ReturnType<typeof rankingsApi>;
