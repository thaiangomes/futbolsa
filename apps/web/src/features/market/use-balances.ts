"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useChannel } from "../../realtime/react";
import type { MarketApi } from "./api";

export interface Balances {
  freeCash: number;
  freeShares: number;
}

/**
 * O caixa e as ações livres do jogador neste clube, para a boleta. Vêm do `me` de `GET /clubs/:ticker/book` e são
 * relidos (no máximo uma vez por 300 ms) quando o canal `me` avisa que a carteira mudou (`wallet.changed`) ou que uma
 * ordem mudou (`order.updated`): a reserva e o saldo andam a cada ordem enviada, cancelada ou executada.
 */
export function useBalances(api: MarketApi, ticker: string | null, enabled: boolean): Balances | null {
  const [balances, setBalances] = useState<Balances | null>(null);
  const apiRef = useRef(api);
  apiRef.current = api;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  const load = useCallback(async () => {
    if (!ticker) return;
    try {
      const view = await apiRef.current.book(ticker);
      if (alive.current) setBalances(view.me ? { freeCash: view.me.freeCash, freeShares: view.me.freeShares } : null);
    } catch {
      // a boleta continua com o último saldo; a API confere de novo no envio
    }
  }, [ticker]);

  useEffect(() => {
    if (!enabled) {
      setBalances(null);
      return;
    }
    void load();
  }, [enabled, load]);

  useChannel(enabled ? "me" : null, {
    onEvent: (event) => {
      if (event.type !== "wallet.changed" && event.type !== "order.updated") return;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void load(), 300);
    },
    onSubscribed: ({ mode }) => {
      if (mode === "resync") void load();
    },
  });

  return balances;
}
