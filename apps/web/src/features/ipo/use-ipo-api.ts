"use client";

import { useMemo } from "react";
import { useSession } from "../accounts/session-provider";
import { type IpoApi, ipoApi } from "./api";

/** O cliente das rotas do IPO, ligado à sessão. */
export function useIpoApi(): IpoApi {
  const { api } = useSession();
  return useMemo(() => ipoApi(api), [api]);
}
