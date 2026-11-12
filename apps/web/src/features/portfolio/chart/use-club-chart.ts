"use client";

import { candleEventSchema, clubChannel, type CandlesResponse, type ChartRange, type MarkersResponse, type MyTradesResponse } from "@futbolsa/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useChannel } from "../../../realtime/react";
import type { PortfolioApi } from "../api";
import { applyCandleEvent } from "./series";

export interface ClubChartData {
  status: "loading" | "ready" | "error";
  candles: CandlesResponse | null;
  markers: MarkersResponse | null;
  mine: MyTradesResponse | null;
  reload(): Promise<void>;
}

/**
 * Os dados do gráfico do clube: os candles, os marcadores públicos e, logado, os meus negócios, tudo pela REST ao abrir e
 * ao trocar o período. O `candle` do canal `club:<ticker>` substitui o candle em andamento (valores absolutos, então
 * aplicar de novo não muda nada); um candle de período mais novo que o último da série (a virada) recarrega a janela, e a
 * assinatura que pede `resync` também.
 */
export function useClubChart(api: PortfolioApi, ticker: string, range: ChartRange, logged: boolean): ClubChartData {
  const [candles, setCandles] = useState<CandlesResponse | null>(null);
  const [markers, setMarkers] = useState<MarkersResponse | null>(null);
  const [mine, setMine] = useState<MyTradesResponse | null>(null);
  const [status, setStatus] = useState<ClubChartData["status"]>("loading");
  const apiRef = useRef(api);
  apiRef.current = api;
  const alive = useRef(true);
  const generation = useRef(0);
  const candlesRef = useRef<CandlesResponse | null>(null);
  candlesRef.current = candles;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    const mineGeneration = ++generation.current;
    try {
      const [c, m, t] = await Promise.all([
        apiRef.current.candles(ticker, range),
        apiRef.current.markers(ticker, range).catch(() => null),
        logged ? apiRef.current.myTrades(ticker, range).catch(() => null) : Promise.resolve(null),
      ]);
      if (!alive.current || mineGeneration !== generation.current) return;
      setCandles(c);
      setMarkers(m);
      setMine(t);
      setStatus("ready");
    } catch {
      if (alive.current && mineGeneration === generation.current) setStatus((s) => (s === "ready" ? s : "error"));
    }
  }, [ticker, range, logged]);

  useEffect(() => {
    setStatus("loading");
    setCandles(null);
    void reload();
  }, [reload]);

  useChannel(clubChannel(ticker), {
    onEvent: (event) => {
      if (event.type === "candle") {
        const parsed = candleEventSchema.safeParse(event.data);
        const current = candlesRef.current;
        if (!parsed.success || !current) return;
        const update = applyCandleEvent(current.candles, current.interval, parsed.data);
        if (update.kind === "replace") setCandles({ ...current, candles: update.candles });
        else if (update.kind === "reload") void reload();
      }
    },
    onSubscribed: ({ mode }) => {
      if (mode === "resync") void reload();
    },
  });

  // um negócio do jogador (wallet.changed no canal me) acrescenta uma seta: relê os meus negócios
  useChannel(logged ? "me" : null, {
    onEvent: (event) => {
      if (event.type !== "entry.added") return;
      apiRef.current.myTrades(ticker, range).then((t) => alive.current && setMine(t)).catch(() => undefined);
    },
  });

  return { status, candles, markers, mine, reload };
}
