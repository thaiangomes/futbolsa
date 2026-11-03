import {
  parseServerMessage,
  type Channel,
  type ErrorCode,
  type EventEnvelope,
  type RealtimeRole,
  type SubscribeMode,
} from "@futbolsa/contracts";
import { Backoff } from "./backoff";

/** O pedaço do `WebSocket` do navegador que o cliente usa; os testes trocam por um falso. */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

const SOCKET_OPEN = 1;

/** Quem recebe os eventos de um canal. */
export interface ChannelHandlers {
  onEvent(event: EventEnvelope): void;
  /** A assinatura foi aceita. Em `resync` o estado local não vale mais: recarregar pela REST. */
  onSubscribed?(info: { seq: number; mode: SubscribeMode }): void;
  onError?(code: ErrorCode): void;
  /** O último `seq` aplicado, para a reassinatura pedir só o que faltou. Sem ele, assina ao vivo. */
  since?(): number | undefined;
}

export type ClientStatus = "idle" | "connecting" | "open" | "reconnecting";

export interface ClientState {
  status: ClientStatus;
  /** Quanto falta para a próxima tentativa, enquanto `reconnecting`. */
  retryInMs: number | null;
  /** O papel que o servidor confirmou nesta conexão; `visitor` sem login. */
  role: RealtimeRole;
}

export interface RealtimeClientOptions {
  /** `ws://…/ws` ou `wss://…/ws`. */
  url: string;
  /** O token do login, ou `null` para entrar como visitante. `forceRefresh` pede um token novo. */
  getToken?: (options?: { forceRefresh?: boolean }) => Promise<string | null>;
  createSocket?: (url: string) => SocketLike;
  random?: () => number;
  /** Sem nenhuma mensagem por este tempo a conexão é dada como morta. */
  silenceMs?: number;
  /** Uma conexão aberta por este tempo zera o recuo. */
  stableMs?: number;
}

type CloseAction = "backoff" | "now" | "refresh" | "visitor";

/**
 * A conexão do site com o tempo real: abre `/ws`, entra com o token, assina os canais pedidos e,
 * quando cai, reabre sozinha (com recuo) e reassina com `since` para não perder nada. Não sabe
 * nada de React nem de telas; os eventos vão para quem assinou cada canal.
 */
export class RealtimeClient {
  private readonly options: Required<Pick<RealtimeClientOptions, "silenceMs" | "stableMs">> & RealtimeClientOptions;
  private readonly backoff = new Backoff();
  private readonly subscriptions = new Map<Channel, Set<ChannelHandlers>>();
  private readonly stateListeners = new Set<(state: ClientState) => void>();

  private socket: SocketLike | null = null;
  /** Cada abertura e cada fechamento do usuário (disconnect/reconnect) muda; o que vier de uma geração velha é ignorado. */
  private generation = 0;
  private active = false;
  private state: ClientState = { status: "idle", retryInMs: null, role: "visitor" };

  private silenceTimer: ReturnType<typeof setTimeout> | undefined;
  private stableTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private openedAt = 0;
  /** O último login deu 4401 e já pedimos token novo. */
  private tokenRetried = false;
  /** O token foi recusado duas vezes: fica visitante até `reconnect()`. */
  private visitorOnly = false;
  private nextOpenForcesRefresh = false;

  constructor(options: RealtimeClientOptions) {
    this.options = { silenceMs: 60_000, stableMs: 10_000, ...options };
  }

  getState(): ClientState {
    return this.state;
  }

  onState(listener: (state: ClientState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Começa a conectar (e a manter a conexão). */
  connect(): void {
    if (this.active) return;
    this.active = true;
    this.setState({ status: "connecting", retryInMs: null });
    void this.open();
  }

  /** Para de vez: fecha a conexão e cancela qualquer reconexão. */
  disconnect(): void {
    this.active = false;
    this.generation += 1;
    this.clearTimers();
    this.detach(this.socket)?.close(1000);
    this.socket = null;
    this.setState({ status: "idle", retryInMs: null, role: "visitor" });
  }

  /** O login mudou (entrou ou saiu): reabre na hora com o login atual. */
  reconnect(): void {
    this.visitorOnly = false;
    this.tokenRetried = false;
    this.backoff.reset();
    this.generation += 1;
    this.clearTimers();
    this.detach(this.socket)?.close(1000);
    this.socket = null;
    this.active = true;
    this.setState({ status: "connecting", retryInMs: null, role: "visitor" });
    void this.open();
  }

  /**
   * Assina um canal. Várias telas podem assinar o mesmo canal: o servidor recebe uma assinatura só.
   * Devolve a função que cancela.
   */
  subscribe(channel: Channel, handlers: ChannelHandlers): () => void {
    let set = this.subscriptions.get(channel);
    if (!set) {
      set = new Set();
      this.subscriptions.set(channel, set);
    }
    set.add(handlers);
    if (set.size === 1) this.sendSubscribe(channel);

    return () => {
      const current = this.subscriptions.get(channel);
      if (!current?.delete(handlers)) return;
      if (current.size === 0) {
        this.subscriptions.delete(channel);
        this.send({ type: "unsubscribe", channel });
      }
    };
  }

  // --- conexão ---

  private async open(): Promise<void> {
    const generation = ++this.generation;
    let token: string | null = null;
    if (this.options.getToken && !this.visitorOnly) {
      try {
        token = await this.options.getToken(this.nextOpenForcesRefresh ? { forceRefresh: true } : undefined);
      } catch {
        token = null;
      }
    }
    this.nextOpenForcesRefresh = false;
    if (generation !== this.generation || !this.active) return;

    const socket = (this.options.createSocket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike))(
      this.options.url,
    );
    this.socket = socket;
    this.setState({ status: "connecting", retryInMs: null, role: "visitor" });

    socket.onopen = () => {
      if (generation !== this.generation) return;
      this.openedAt = Date.now();
      this.setState({ status: "open", retryInMs: null });
      this.armSilence(generation);
      this.stableTimer = setTimeout(() => {
        this.backoff.reset();
        this.stableTimer = undefined;
      }, this.options.stableMs);
      if (token) this.send({ type: "auth", token });
      for (const channel of this.subscriptions.keys()) this.sendSubscribe(channel);
    };
    socket.onmessage = (event) => {
      if (generation !== this.generation) return;
      this.armSilence(generation);
      if (typeof event.data === "string") this.handleMessage(event.data);
    };
    socket.onclose = (event) => {
      if (generation !== this.generation) return;
      this.onClosed(event.code, generation);
    };
    socket.onerror = () => {
      // o navegador sempre manda um `close` logo depois; é lá que se decide
    };
  }

  private handleMessage(raw: string): void {
    const message = parseServerMessage(raw);
    if (!message) return;

    if (message.channel !== "system") {
      for (const handlers of this.subscriptions.get(message.channel) ?? []) handlers.onEvent(message);
      return;
    }
    switch (message.type) {
      case "auth.ok":
        this.tokenRetried = false;
        this.setState({ role: message.data.role });
        break;
      case "subscribed":
        for (const handlers of this.subscriptions.get(message.data.channel) ?? []) {
          handlers.onSubscribed?.({ seq: message.data.seq, mode: message.data.mode });
        }
        break;
      case "error": {
        const channel = message.data.channel;
        if (channel) {
          for (const handlers of this.subscriptions.get(channel as Channel) ?? []) handlers.onError?.(message.data.code);
        }
        break;
      }
      default:
        break;
    }
  }

  private onClosed(code: number, generation: number): void {
    const livedMs = this.openedAt ? Date.now() - this.openedAt : 0;
    this.openedAt = 0;
    this.clearTimers();
    this.socket = null;
    if (!this.active || generation !== this.generation) return;

    const action = this.actionFor(code, livedMs);
    if (action === "visitor") this.visitorOnly = true;
    if (action === "refresh") this.nextOpenForcesRefresh = true;
    if (action === "now" || action === "refresh" || action === "visitor") {
      this.setState({ status: "connecting", retryInMs: null, role: "visitor" });
      void this.open();
      return;
    }
    const delay = this.backoff.next(this.options.random);
    this.setState({ status: "reconnecting", retryInMs: delay, role: "visitor" });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.setState({ status: "connecting", retryInMs: null });
      void this.open();
    }, delay);
  }

  /** O que fazer depois de a conexão fechar com este código. */
  private actionFor(code: number, livedMs: number): CloseAction {
    if (code === 4401) {
      // token inválido: pede um novo uma vez; se o novo também falhar, vira visitante e para
      if (this.tokenRetried) return "visitor";
      this.tokenRetried = true;
      return "refresh";
    }
    // 4402 (venceu) e 4403 (conta ou papel mudou): reabre na hora, a não ser que a conexão tenha caído logo ao abrir
    if ((code === 4402 || code === 4403) && livedMs >= 1_000) return code === 4402 ? "refresh" : "now";
    return "backoff";
  }

  // --- envio e relógios ---

  private sendSubscribe(channel: Channel): void {
    if (!this.isOpen()) return;
    const since = [...(this.subscriptions.get(channel) ?? [])]
      .map((h) => h.since?.())
      .filter((seq): seq is number => seq !== undefined && seq > 0)
      .sort((a, b) => a - b)[0];
    this.send(since === undefined ? { type: "subscribe", channel } : { type: "subscribe", channel, since });
  }

  private send(message: unknown): void {
    if (this.isOpen()) this.socket!.send(JSON.stringify(message));
  }

  private isOpen(): boolean {
    return this.socket !== null && this.socket.readyState === SOCKET_OPEN;
  }

  /** Sem nada do servidor por `silenceMs` (nem o heartbeat), a conexão é dada como morta. */
  private armSilence(generation: number): void {
    clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      if (generation !== this.generation) return;
      this.detach(this.socket)?.close(4000, "silêncio");
      this.onClosed(1006, generation);
    }, this.options.silenceMs);
  }

  private clearTimers(): void {
    clearTimeout(this.silenceTimer);
    clearTimeout(this.stableTimer);
    clearTimeout(this.retryTimer);
    this.silenceTimer = this.stableTimer = this.retryTimer = undefined;
  }

  /** Solta os ouvintes do socket, para um `close` tardio dele não mexer no cliente. */
  private detach(socket: SocketLike | null): SocketLike | null {
    if (!socket) return null;
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    return socket;
  }

  private setState(patch: Partial<ClientState>): void {
    const next = { ...this.state, ...patch };
    if (next.status === this.state.status && next.retryInMs === this.state.retryInMs && next.role === this.state.role) return;
    this.state = next;
    for (const listener of this.stateListeners) listener(this.state);
  }
}
