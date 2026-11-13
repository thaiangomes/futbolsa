"use client";

import { useMemo } from "react";
import { useSession } from "../accounts/session-provider";
import { type EntryApi, entryApi } from "./api";

/** O cliente das rotas da entrada, ligado à sessão. */
export function useEntryApi(): EntryApi {
  const { api } = useSession();
  return useMemo(() => entryApi(api), [api]);
}
