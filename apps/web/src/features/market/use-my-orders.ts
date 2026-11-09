"use client";

import type { MyOrder } from "@futbolsa/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useChannel } from "../../realtime/react";
import type { MarketApi } from "./api";
import { applyOrderEvent } from "./my-orders-state";

export interface MyOrdersData {
  /** `null` até a primeira carga (ou sem login). */
  orders: MyOrder[] | null;
  error: boolean;
  /** Relê as ordens pela REST. */
  reload(): Promise<void>;
}

/**
 * As ordens abertas do jogador: `GET /orders?status=open` ao abrir e o `order.updated` do canal `me` (só o dono
 * assina) por cima. A rota REST do `me` não traz `seq`, então, como o IPO, a tela aplica cada evento no estado e relê
 * pela REST se um evento chegou durante a carga ou se a assinatura pediu `resync`. Sem login (`enabled` falso) não
 * assina nem lê nada.
 */
export function useMyOrders(api: MarketApi, enabled: boolean): MyOrdersData {
  const [orders, setOrders] = useState<MyOrder[] | null>(null);
  const [error, setError] = useState(false);
  const loading = useRef(false);
  const dirty = useRef(false);
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
    if (loading.current) {
      dirty.current = true;
      return;
    }
    loading.current = true;
    try {
      do {
        dirty.current = false;
        try {
          const next = (await apiRef.current.openOrders()).orders;
          if (alive.current) {
            setOrders(next);
            setError(false);
          }
        } catch {
          if (alive.current) setError(true);
        }
      } while (dirty.current && alive.current);
    } finally {
      loading.current = false;
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setOrders(null);
      return;
    }
    void reload();
  }, [enabled, reload]);

  useChannel(enabled ? "me" : null, {
    onEvent: (event) => {
      if (event.type !== "order.updated") return;
      // durante a carga o evento pode já estar na resposta ou não: relê depois
      if (loading.current) dirty.current = true;
      setOrders((current) => (current ? applyOrderEvent(current, event) : current));
    },
    onSubscribed: ({ mode }) => {
      if (mode === "resync") void reload();
    },
  });

  return { orders, error, reload };
}
