import {
  type ChartRange,
  type EntriesQuery,
  candlesResponseSchema,
  entriesResponseSchema,
  historyResponseSchema,
  equityResponseSchema,
  markersResponseSchema,
  myTradesResponseSchema,
  publicPlayerSchema,
  walletViewSchema,
} from "@futbolsa/contracts";
import type { ApiClient } from "../../lib/api";

function queryString(params: Record<string, string | number | undefined>): string {
  const q = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
  return q ? `?${q}` : "";
}

/** As rotas da carteira e dos gráficos da F10, tipadas pelos contratos (a resposta é conferida pelo esquema zod). */
export function portfolioApi(api: ApiClient) {
  return {
    /** `GET /portfolio`: a carteira do jogador logado. */
    wallet: () => api.request(walletViewSchema, "/portfolio"),
    /** `GET /portfolio/entries`: o extrato, do mais novo para o mais antigo, por cursor. */
    entries: (query: Partial<Pick<EntriesQuery, "club" | "kind" | "before" | "limit">> = {}) =>
      api.request(entriesResponseSchema, `/portfolio/entries${queryString({ club: query.club, kind: query.kind, before: query.before, limit: query.limit })}`),
    /** `GET /portfolio/equity`: o patrimônio dia a dia. */
    equity: () => api.request(equityResponseSchema, "/portfolio/equity"),
    /** `GET /clubs/:ticker/candles`: público. */
    candles: (ticker: string, range: ChartRange) => api.request(candlesResponseSchema, `/clubs/${encodeURIComponent(ticker)}/candles?range=${range}`),
    /** `GET /clubs/:ticker/markers`: jogos e dividendos, público. */
    markers: (ticker: string, range: ChartRange) => api.request(markersResponseSchema, `/clubs/${encodeURIComponent(ticker)}/markers?range=${range}`),
    /** `GET /portfolio/clubs/:ticker/trades`: meus negócios e o meu preço médio (com login). */
    myTrades: (ticker: string, range: ChartRange) => api.request(myTradesResponseSchema, `/portfolio/clubs/${encodeURIComponent(ticker)}/trades?range=${range}`),
    /** `GET /me/history`: as temporadas encerradas do jogador. */
    history: () => api.request(historyResponseSchema, "/me/history"),
    /** `GET /players/:nickname`: o perfil público, com a foto mensal. */
    player: (nickname: string) => api.request(publicPlayerSchema, `/players/${encodeURIComponent(nickname)}`),
  };
}

export type PortfolioApi = ReturnType<typeof portfolioApi>;
