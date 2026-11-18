"use client";

import { type EventEnvelope, type LiveGames, priceEventSchema } from "@futbolsa/contracts";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useChannel } from "../../realtime/react";
import { useSession } from "../accounts/session-provider";
import { type LiveGamesApi, liveGamesApi } from "./api";
import { applyPriceToGames } from "./model";

export interface LiveGamesState {
  data: LiveGames | null;
  error: boolean;
}

/** Os jogos ao vivo que a faixa e a página dividem (uma leitura só para as duas). */
export const LiveGamesContext = createContext<LiveGamesState>({ data: null, error: false });
export const useLiveGames = (): LiveGamesState => useContext(LiveGamesContext);

/** O placar chega da fonte a cada 5 minutos; reler a cada 30 segundos mantém o atraso pequeno. */
const REFRESH_MS = 30_000;

/**
 * Lê `GET /live-games` ao abrir e a cada 30 segundos, e mantém o preço e a variação do dia pelo canal `prices`, como a lista
 * do Mercado. Um `price` com `seq` maior que o da leitura vale por cima dela. Falha de leitura não derruba nada: a faixa
 * simplesmente não aparece.
 */
export function useLiveGamesLoader(api: LiveGamesApi): LiveGamesState {
  const [state, setState] = useState<LiveGamesState>({ data: null, error: false });
  const alive = useRef(true);
  const apiRef = useRef(api);
  apiRef.current = api;
  const load = useCallback(async () => {
    try {
      const data = await apiRef.current.read();
      if (alive.current) setState({ data, error: false });
    } catch {
      if (alive.current) setState((s) => ({ data: s.data, error: true }));
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [load]);
  useChannel("prices", {
    onEvent: (event: EventEnvelope) => {
      if (event.type !== "price") return;
      const parsed = priceEventSchema.safeParse(event.data);
      if (!parsed.success) return;
      setState((s) => (s.data ? { ...s, data: applyPriceToGames(s.data, parsed.data) } : s));
    },
    onSubscribed: ({ mode }) => {
      if (mode === "resync") void load();
    },
  });
  return state;
}

/** O provedor do site: usa o cliente da sessão e entra no layout, para a faixa valer em todas as telas. */
export function LiveGamesProvider({ children }: { children: ReactNode }) {
  const { api } = useSession();
  const live = useMemo(() => liveGamesApi(api), [api]);
  const state = useLiveGamesLoader(live);
  return <LiveGamesContext.Provider value={state}>{children}</LiveGamesContext.Provider>;
}
