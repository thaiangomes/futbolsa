import {
  deleteBidResponseSchema,
  ipoOverviewSchema,
  ipoResultsSchema,
  type PutBidBody,
  putBidBodySchema,
  putBidResponseSchema,
} from "@futbolsa/contracts";
import type { ApiClient } from "../../lib/api";

/** As rotas do IPO da F8, tipadas pelos contratos (a resposta é conferida pelo esquema zod). */
export function ipoApi(api: ApiClient) {
  return {
    overview: () => api.request(ipoOverviewSchema, "/ipo"),
    results: () => api.request(ipoResultsSchema, "/ipo/results"),
    putBid: (ticker: string, body: PutBidBody) =>
      api.request(putBidResponseSchema, `/ipo/bids/${encodeURIComponent(ticker)}`, { method: "PUT", body: putBidBodySchema.parse(body) }),
    deleteBid: (ticker: string) => api.request(deleteBidResponseSchema, `/ipo/bids/${encodeURIComponent(ticker)}`, { method: "DELETE" }),
  };
}

export type IpoApi = ReturnType<typeof ipoApi>;
