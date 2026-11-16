"use client";

import type { ClubValueView, Projection, ProjectionList } from "@futbolsa/contracts";
import { useEffect, useRef, useState } from "react";

/** Minhas projeções por ticker, lidas de `GET /me/projections`. `null` enquanto carrega, sem login ou se a leitura falhar (a coluna não aparece). */
export function useProjections(api: { projections(): Promise<ProjectionList> }, logged: boolean): ReadonlyMap<string, Projection> | null {
  const [map, setMap] = useState<ReadonlyMap<string, Projection> | null>(null);
  useEffect(() => {
    if (!logged) {
      setMap(null);
      return;
    }
    let alive = true;
    Promise.resolve()
      .then(() => api.projections())
      .then(
        (r) => alive && setMap(new Map(r.projections.map((p) => [p.ticker, p]))),
        () => alive && setMap(null),
      );
    return () => {
      alive = false;
    };
  }, [api, logged]);
  return map;
}

const REFRESH_MS = 60_000;

/**
 * Os dividendos públicos de cada clube com projeção (`GET /clubs/:ticker/dividends`), para refazer o valor com o que já
 * foi pago e a fase de cada copa de agora. Relê a cada minuto, junto com a lista do Mercado, para o valor acompanhar os pagamentos.
 */
export function useProjectedViews(api: { dividends(ticker: string): Promise<ClubValueView> }, projections: ReadonlyMap<string, Projection> | null | undefined): ReadonlyMap<string, ClubValueView> {
  const [views, setViews] = useState<ReadonlyMap<string, ClubValueView>>(new Map());
  const tickers = projections ? [...projections.keys()].sort().join(",") : "";
  const apiRef = useRef(api);
  apiRef.current = api;
  useEffect(() => {
    if (tickers === "") {
      setViews(new Map());
      return;
    }
    let alive = true;
    const load = async () => {
      const got = await Promise.all(
        tickers.split(",").map((t) => Promise.resolve().then(() => apiRef.current.dividends(t)).then((v) => [t, v] as const, () => null)),
      );
      if (alive) setViews((old) => new Map([...old, ...got.filter((g): g is readonly [string, ClubValueView] => g !== null)]));
    };
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [tickers]);
  return views;
}
