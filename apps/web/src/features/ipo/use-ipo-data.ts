"use client";

import type { IpoOverview, IpoResults } from "@futbolsa/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useChannel } from "../../realtime/react";
import type { IpoApi } from "./api";
import { ipoErrorMessage } from "./forms";

export interface IpoData {
  overview: IpoOverview | null;
  results: IpoResults | null;
  error: string | null;
  loading: boolean;
  /** Relê a visão geral e o resultado (várias chamadas seguidas viram no máximo uma a mais). */
  reload(): Promise<void>;
  /** Troca a visão geral pelo que a API acabou de devolver (salvar ou cancelar uma oferta). */
  update(change: (current: IpoOverview) => IpoOverview): void;
}

/**
 * O estado da tela do IPO: lê `GET /ipo` e `GET /ipo/results` ao abrir e relê quando o servidor avisa
 * (`season.status` no canal da temporada; `wallet.changed` e `entry.added` no canal da conta), para a
 * tela atualizar sem recarregar a página.
 */
export function useIpoData(api: IpoApi): IpoData {
  const [overview, setOverview] = useState<IpoOverview | null>(null);
  const [results, setResults] = useState<IpoResults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const running = useRef(false);
  const again = useRef(false);
  const alive = useRef(true);
  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    if (running.current) {
      again.current = true;
      return;
    }
    running.current = true;
    try {
      do {
        again.current = false;
        try {
          const [nextOverview, nextResults] = await Promise.all([apiRef.current.overview(), apiRef.current.results()]);
          if (!alive.current) return;
          setOverview(nextOverview);
          setResults(nextResults);
          setError(null);
        } catch (e) {
          if (alive.current) setError(ipoErrorMessage(e));
        }
      } while (again.current && alive.current);
    } finally {
      running.current = false;
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useChannel("season", { onEvent: (e) => e.type === "season.status" && void reload() });
  useChannel("me", { onEvent: (e) => (e.type === "wallet.changed" || e.type === "entry.added") && void reload() });

  const update = useCallback((change: (current: IpoOverview) => IpoOverview) => {
    setOverview((current) => (current ? change(current) : current));
  }, []);

  return { overview, results, error, loading, reload, update };
}
