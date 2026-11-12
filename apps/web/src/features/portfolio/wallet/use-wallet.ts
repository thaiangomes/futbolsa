"use client";

import { priceEventSchema, type EntryItem, type WalletView } from "@futbolsa/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useChannel } from "../../../realtime/react";
import type { PortfolioApi } from "../api";
import { applyPriceToWallet, entryQuery, type EntryFilter, priceChangesHeldClub } from "./wallet-state";

/** Relê no máximo uma vez por esse tempo quando o canal avisa de mudança (vários eventos juntos viram uma leitura só). */
const RELOAD_DELAY_MS = 300;
/** O preço muda com frequência: a leitura que ele pede é mais espaçada. */
const PRICE_RELOAD_MS = 2000;

export interface WalletData {
  /** `null` até a primeira carga. */
  view: WalletView | null;
  error: "none" | "load" | "not_found";
  reload(): Promise<void>;
}

/**
 * A carteira do jogador: `GET /portfolio` ao abrir e o que o canal `me` avisa por cima (`wallet.changed`, `order.updated`,
 * `payout.credited`, `entry.added`): a tela relê a carteira, porque o patrimônio e o valor a mercado são contas do
 * servidor. O canal `prices` troca na hora o aviso de leilão das posições (T23) e, se o preço de um clube que o jogador
 * tem mudou, pede a releitura (espaçada). Sem login (`enabled` falso) não lê nem assina nada.
 */
export function useWallet(api: PortfolioApi, enabled: boolean): WalletData {
  const [view, setView] = useState<WalletView | null>(null);
  const [error, setError] = useState<WalletData["error"]>("none");
  const apiRef = useRef(api);
  apiRef.current = api;
  const alive = useRef(true);
  const loading = useRef(false);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const viewRef = useRef<WalletView | null>(null);
  viewRef.current = view;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
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
          const next = await apiRef.current.wallet();
          if (alive.current) {
            setView(next);
            setError("none");
          }
        } catch (e) {
          if (alive.current) setError((e as { status?: number }).status === 404 ? "not_found" : "load");
        }
      } while (dirty.current && alive.current);
    } finally {
      loading.current = false;
    }
  }, []);

  const schedule = useCallback(
    (delay: number) => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void reload(), delay);
    },
    [reload],
  );

  useEffect(() => {
    if (!enabled) {
      setView(null);
      return;
    }
    void reload();
  }, [enabled, reload]);

  useChannel(enabled ? "me" : null, {
    onEvent: (event) => {
      if (event.type === "wallet.changed" || event.type === "order.updated" || event.type === "payout.credited" || event.type === "entry.added") schedule(RELOAD_DELAY_MS);
    },
    onSubscribed: ({ mode }) => {
      if (mode === "resync") void reload();
    },
  });

  useChannel(enabled && view && view.positions.length > 0 ? "prices" : null, {
    onEvent: (event) => {
      if (event.type !== "price") return;
      const parsed = priceEventSchema.safeParse(event.data);
      const current = viewRef.current;
      if (!parsed.success || !current) return;
      setView(applyPriceToWallet(current, parsed.data));
      if (priceChangesHeldClub(current, parsed.data)) schedule(PRICE_RELOAD_MS);
    },
  });

  return { view, error, reload };
}

export interface EntriesData {
  items: EntryItem[];
  /** `null` até a primeira carga. */
  loaded: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  error: boolean;
  loadMore(): Promise<void>;
  reload(): Promise<void>;
}

/**
 * O extrato com filtro e "carregar mais": a primeira página pela REST e as seguintes pelo cursor. Uma linha nova do canal
 * `me` (`entry.added`) relê o início do extrato; o filtro novo recomeça da primeira página.
 */
export function useEntries(api: PortfolioApi, enabled: boolean, filter: EntryFilter): EntriesData {
  const [items, setItems] = useState<EntryItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const apiRef = useRef(api);
  apiRef.current = api;
  const alive = useRef(true);
  const generation = useRef(0);
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
    };
  }, []);

  const reload = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const page = await apiRef.current.entries(entryQuery(filterRef.current));
      if (!alive.current || mine !== generation.current) return;
      setItems(page.items);
      setCursor(page.nextCursor);
      setLoaded(true);
      setError(false);
    } catch {
      if (alive.current && mine === generation.current) setError(true);
    }
  }, []);

  const club = filter.club;
  const kind = filter.kind;
  useEffect(() => {
    if (!enabled) {
      setItems([]);
      setLoaded(false);
      return;
    }
    setLoaded(false);
    void reload();
  }, [enabled, club, kind, reload]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    const mine = generation.current;
    setLoadingMore(true);
    try {
      const page = await apiRef.current.entries(entryQuery(filterRef.current, cursor));
      if (!alive.current || mine !== generation.current) return;
      setItems((current) => {
        const seen = new Set(current.map((i) => i.id));
        return [...current, ...page.items.filter((i) => !seen.has(i.id))];
      });
      setCursor(page.nextCursor);
    } catch {
      if (alive.current) setError(true);
    } finally {
      if (alive.current) setLoadingMore(false);
    }
  }, [cursor, loadingMore]);

  useChannel(enabled ? "me" : null, {
    onEvent: (event) => {
      if (event.type !== "entry.added") return;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void reload(), 300);
    },
    onSubscribed: ({ mode }) => {
      if (mode === "resync") void reload();
    },
  });

  return { items, loaded, hasMore: cursor !== null, loadingMore, error, loadMore, reload };
}
