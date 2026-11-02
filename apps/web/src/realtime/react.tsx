"use client";

import type { Channel, EventEnvelope } from "@futbolsa/contracts";
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { RealtimeClient, type ChannelHandlers, type ClientState, type RealtimeClientOptions } from "./client";
import { SyncedChannel, type SyncedSnapshot } from "./synced-channel";
import { wsUrlFromApiUrl } from "./url";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

/** O que o provedor usa do cliente; o `RealtimeClient` de verdade ou um falso nos testes. */
export type RealtimeClientLike = Pick<
  RealtimeClient,
  "connect" | "disconnect" | "reconnect" | "subscribe" | "getState" | "onState"
>;

const RealtimeContext = createContext<RealtimeClientLike | null>(null);

export interface RealtimeProviderProps {
  children: ReactNode;
  /** O token do login (T13). Sem ele, todos entram como visitantes. */
  getToken?: RealtimeClientOptions["getToken"];
  /** Troca o cliente (testes). */
  createClient?: (options: RealtimeClientOptions) => RealtimeClientLike;
}

/**
 * Uma conexão só para o site inteiro. O cliente nasce na primeira renderização (sem abrir
 * socket: o `WebSocket` só é criado dentro do `connect`) e conecta num efeito, então a
 * exportação estática do Next não toca em `WebSocket`.
 */
export function RealtimeProvider({ children, getToken, createClient }: RealtimeProviderProps) {
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;

  const [client] = useState<RealtimeClientLike>(() => {
    const options: RealtimeClientOptions = {
      url: wsUrlFromApiUrl(API_URL),
      getToken: (opts) => (getTokenRef.current ? getTokenRef.current(opts) : Promise.resolve(null)),
    };
    return createClient ? createClient(options) : new RealtimeClient(options);
  });

  useEffect(() => {
    client.connect();
    return () => client.disconnect();
  }, [client]);

  return createElement(RealtimeContext.Provider, { value: client }, children);
}

/** O cliente da conexão do site. Só dentro do `RealtimeProvider`. */
export function useRealtimeClient(): RealtimeClientLike {
  const client = useContext(RealtimeContext);
  if (!client) throw new Error("useRealtimeClient precisa estar dentro de um RealtimeProvider");
  return client;
}

const SERVER_STATE: ClientState = { status: "idle", retryInMs: null, role: "visitor" };

/** O estado da conexão (conectando, aberta, reconectando em X ms) e o papel confirmado pelo servidor. */
export function useRealtimeState(): ClientState {
  const client = useRealtimeClient();
  return useSyncExternalStore(client.onState, client.getState, () => SERVER_STATE);
}

/** Assina um canal enquanto o componente existe. Para estado que também vem da REST, use `useSyncedChannel`. */
export function useChannel(channel: Channel | null, handlers: ChannelHandlers): void {
  const client = useRealtimeClient();
  const latest = useRef(handlers);
  latest.current = handlers;

  useEffect(() => {
    if (!channel) return;
    return client.subscribe(channel, {
      onEvent: (event) => latest.current.onEvent(event),
      onSubscribed: (info) => latest.current.onSubscribed?.(info),
      onError: (code) => latest.current.onError?.(code),
      since: () => latest.current.since?.(),
    });
  }, [client, channel]);
}

const IDLE_SNAPSHOT: SyncedSnapshot<never> = { status: "idle", state: null };
const noopSubscribe = () => () => {};

/**
 * Estado de uma tela que vem da REST e se mantém por eventos (livro, carteira, parcial do
 * ranking). `load` devolve o estado e o `seq` lido antes do banco; `apply` aplica um evento.
 * Os dois podem mudar a cada renderização; o canal só é refeito quando o `channel` muda.
 */
export function useSyncedChannel<S>(
  channel: Channel | null,
  load: () => Promise<{ state: S; seq: number }>,
  apply: (state: S, event: EventEnvelope) => S,
): SyncedSnapshot<S> {
  const client = useRealtimeClient();
  const loadRef = useRef(load);
  const applyRef = useRef(apply);
  loadRef.current = load;
  applyRef.current = apply;

  const [store, setStore] = useState<SyncedChannel<S> | null>(null);
  useEffect(() => {
    if (!channel) {
      setStore(null);
      return;
    }
    const synced = new SyncedChannel<S>({
      client,
      channel,
      load: () => loadRef.current(),
      apply: (state, event) => applyRef.current(state, event),
    });
    synced.start();
    setStore(synced);
    return () => {
      synced.stop();
      setStore(null);
    };
  }, [client, channel]);

  return useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? store.getSnapshot : () => IDLE_SNAPSHOT as SyncedSnapshot<S>,
    () => IDLE_SNAPSHOT as SyncedSnapshot<S>,
  );
}

const ROLE_LABEL = { visitor: "visitante", player: "jogador", admin: "administrador" } as const;

/** A linha de diagnóstico: "Tempo real: conectado (jogador)", "reconectando em 4 s"... */
export function RealtimeStatusLine() {
  const state = useRealtimeState();
  let text: string;
  switch (state.status) {
    case "open":
      text = `conectado (${ROLE_LABEL[state.role]})`;
      break;
    case "reconnecting":
      text = `reconectando em ${Math.round((state.retryInMs ?? 0) / 1000)} s`;
      break;
    case "connecting":
      text = "conectando…";
      break;
    default:
      text = "desligado";
  }
  return createElement("p", { "data-testid": "realtime-status" }, `Tempo real: ${text}`);
}
