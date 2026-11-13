import {
  type AdjustBody,
  adjustResponseSchema,
  auditResponseSchema,
  type AuditQuery,
  blockResponseSchema,
  botsViewSchema,
  type BotsView,
  deletePlayerResponseSchema,
  entriesResponseSchema,
  type EntriesQuery,
  type PatchBotsBody,
  patchBotsResponseSchema,
  playerDetailSchema,
  playersListSchema,
  type PlayersQuery,
  adminLogResponseSchema,
  adminMatchSchema,
  type AdminLogQuery,
  type CreateMatchBody,
  createMatchBodySchema,
  cupViewSchema,
  currentSeasonResponseSchema,
  knownClubsResponseSchema,
  marketMakerStateSchema,
  marketMakerViewSchema,
  type MarketMakerBody,
  listMatchesResponseSchema,
  overviewSchema,
  pendingResponseSchema,
  type ApplyCorrectionBody,
  applyCorrectionResponseSchema,
  type ApprovePayoutsBody,
  approvePayoutsResponseSchema,
  correctionPreviewSchema,
  payoutHoldersResponseSchema,
  type PayoutListQuery,
  payoutListResponseSchema,
  type PatchMatchBody,
  type PatchSeasonBody,
  type PutCupBody,
  type PutSeasonClubsBody,
  type PutSeasonRulesBody,
  type RunImportBody,
  runImportResponseSchema,
  seasonClubsResponseSchema,
  seasonRulesResponseSchema,
  seasonRulesSchema,
  seasonViewSchema,
  standingsResponseSchema,
  standingsViewSchema,
  suspensionStateSchema,
  type StandingsCompetition,
  type ListMatchesQuery,
} from "@futbolsa/contracts";
import type { ApiClient } from "../../lib/api";

/** Monta a query string só com o que tem valor. */
export function queryString(params: Record<string, string | number | boolean | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== "");
  return entries.length ? `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString()}` : "";
}

/**
 * As rotas do admin da F7, tipadas pelos contratos. A proteção de verdade é a da API (`@AdminOnly`);
 * a tela só esconde o que o jogador comum não pode usar.
 */
export function adminApi(api: ApiClient) {
  return {
    overview: () => api.request(overviewSchema, "/admin/overview"),
    pending: () => api.request(pendingResponseSchema, "/admin/pending"),
    matches: (query: Partial<ListMatchesQuery> = {}) =>
      api.request(listMatchesResponseSchema, `/admin/matches${queryString({ ...query, diverging: query.diverging === undefined ? undefined : String(query.diverging) })}`),
    createMatch: (body: CreateMatchBody) => api.request(adminMatchSchema, "/admin/matches", { method: "POST", body: createMatchBodySchema.parse(body) }),
    patchMatch: (id: number, body: PatchMatchBody) => api.request(adminMatchSchema, `/admin/matches/${id}`, { method: "PATCH", body }),
    runImport: (body: RunImportBody = {}) => api.request(runImportResponseSchema, "/admin/imports/run", { method: "POST", body }),

    standings: () => api.request(standingsResponseSchema, "/admin/standings"),
    correctStandings: (competition: StandingsCompetition, order: number[], reason: string) =>
      api.request(standingsViewSchema, `/admin/standings/${competition}`, { method: "PATCH", body: { order, reason } }),
    confirmStandings: (competition: StandingsCompetition) =>
      api.request(standingsViewSchema, `/admin/standings/${competition}/confirm`, { method: "POST" }),

    knownClubs: () => api.request(knownClubsResponseSchema, "/admin/clubs"),
    currentSeason: () => api.request(currentSeasonResponseSchema, "/admin/seasons/current"),
    createSeason: (year: number) => api.request(seasonViewSchema, "/admin/seasons", { method: "POST", body: { year } }),
    patchSeason: (id: number, body: PatchSeasonBody) => api.request(seasonViewSchema, `/admin/seasons/${id}`, { method: "PATCH", body }),
    putClubs: (id: number, body: PutSeasonClubsBody) => api.request(seasonClubsResponseSchema, `/admin/seasons/${id}/clubs`, { method: "PUT", body }),
    rules: (id: number) => api.request(seasonRulesResponseSchema, `/admin/seasons/${id}/rules`),
    putRules: (id: number, body: PutSeasonRulesBody) => api.request(seasonRulesSchema, `/admin/seasons/${id}/rules`, { method: "PUT", body }),
    putCup: (id: number, competition: string, body: PutCupBody) => api.request(cupViewSchema, `/admin/seasons/${id}/cups/${competition}`, { method: "PUT", body }),
    confirmCup: (id: number, competition: string) => api.request(cupViewSchema, `/admin/seasons/${id}/cups/${competition}/confirm`, { method: "POST" }),

    suspensions: () => api.request(suspensionStateSchema, "/admin/suspensions"),
    suspend: (reason: string, ticker?: string) => api.request(suspensionStateSchema, "/admin/suspensions", { method: "POST", body: { reason, ...(ticker ? { ticker } : {}) } }),
    resume: (ticker?: string) => api.request(suspensionStateSchema, ticker ? `/admin/suspensions/${ticker}` : "/admin/suspensions", { method: "DELETE" }),

    marketMaker: () => api.request(marketMakerViewSchema, "/admin/market-maker"),
    updateMarketMaker: (body: MarketMakerBody) => api.request(marketMakerStateSchema, "/admin/market-maker", { method: "PATCH", body }),

    payouts: (query: Partial<PayoutListQuery> = {}) => api.request(payoutListResponseSchema, `/admin/payouts${queryString(query)}`),
    payoutHolders: (id: number, page = 1) => api.request(payoutHoldersResponseSchema, `/admin/payouts/${id}/holders${queryString({ page, pageSize: 50 })}`),
    approvePayouts: (body: ApprovePayoutsBody) => api.request(approvePayoutsResponseSchema, "/admin/payouts/approve", { method: "POST", body }),
    correctionPreview: () => api.request(correctionPreviewSchema, "/admin/payouts/corrections"),
    applyCorrection: (body: ApplyCorrectionBody) => api.request(applyCorrectionResponseSchema, "/admin/payouts/corrections", { method: "POST", body }),

    players: (query: Partial<PlayersQuery> = {}) => api.request(playersListSchema, `/admin/players${queryString(query)}`),
    player: (id: string) => api.request(playerDetailSchema, `/admin/players/${id}`),
    playerEntries: (id: string, query: Partial<EntriesQuery> = {}) => api.request(entriesResponseSchema, `/admin/players/${id}/entries${queryString(query)}`),
    blockPlayer: (id: string, reason: string) => api.request(blockResponseSchema, `/admin/players/${id}/block`, { method: "POST", body: { reason } }),
    unblockPlayer: (id: string, reason: string) => api.request(blockResponseSchema, `/admin/players/${id}/unblock`, { method: "POST", body: { reason } }),
    deletePlayer: (id: string, confirmNickname: string, reason: string) =>
      api.request(deletePlayerResponseSchema, `/admin/players/${id}`, { method: "DELETE", body: { confirmNickname, reason } }),
    /** Um clique duplo não credita duas vezes: a chave do envio é a mesma até a resposta chegar (proposta 7). */
    adjustPlayer: (id: string, body: AdjustBody, idempotencyKey: string) =>
      api.request(adjustResponseSchema, `/admin/players/${id}/adjust`, { method: "POST", body, headers: { "idempotency-key": idempotencyKey } }),

    trades: (query: Partial<AuditQuery> = {}) => api.request(auditResponseSchema, `/admin/trades${queryString(query)}`),

    bots: (): Promise<BotsView> => api.request(botsViewSchema, "/admin/bots"),
    updateBots: (body: PatchBotsBody) => api.request(patchBotsResponseSchema, "/admin/bots", { method: "PATCH", body }),

    log: (query: Partial<AdminLogQuery> = {}) => api.request(adminLogResponseSchema, `/admin/log${queryString(query)}`),
  };
}

export type AdminApi = ReturnType<typeof adminApi>;
