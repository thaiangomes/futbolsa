"use client";

import { type AuctionState, priceEventSchema } from "@futbolsa/contracts";
import { useEffect, useState } from "react";
import { useChannel } from "../../../realtime/react";
import type { MarketApi } from "../../market/api";

/**
 * O leilão de cada clube (por ticker), para o aviso das ordens abertas: `GET /clubs` ao abrir e o `auction` do canal
 * `prices` por cima, sem recarregar. Sem login (`enabled` falso) não lê nem assina nada.
 */
export function useAuctions(api: MarketApi, enabled: boolean): ReadonlyMap<string, AuctionState | null> {
  const [map, setMap] = useState<ReadonlyMap<string, AuctionState | null>>(new Map());

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    api
      .clubs()
      .then((list) => {
        if (alive) setMap(new Map(list.clubs.map((c) => [c.ticker, c.auction])));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [api, enabled]);

  useChannel(enabled ? "prices" : null, {
    onEvent: (event) => {
      if (event.type !== "price") return;
      const parsed = priceEventSchema.safeParse(event.data);
      if (!parsed.success) return;
      const { ticker, auction } = parsed.data;
      setMap((current) => new Map(current).set(ticker, auction));
    },
  });

  return map;
}
