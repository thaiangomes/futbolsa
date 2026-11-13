import { enterBodySchema, enterResultSchema, entryPreviewSchema, type EntryModeChoice } from "@futbolsa/contracts";
import type { ApiClient } from "../../lib/api";

/** As rotas da entrada no meio da temporada (F11), tipadas pelos contratos. */
export function entryApi(api: ApiClient) {
  return {
    preview: () => api.request(entryPreviewSchema, "/entry/preview"),
    enter: (mode: EntryModeChoice) => api.request(enterResultSchema, "/entry", { method: "POST", body: enterBodySchema.parse({ mode }) }),
  };
}

export type EntryApi = ReturnType<typeof entryApi>;
