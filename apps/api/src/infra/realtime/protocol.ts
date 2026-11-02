import {
  CLOSE_CODES,
  SYSTEM_CHANNEL,
  channelKind,
  parseChannel,
  parseClientMessage,
  type AuthErrorCode,
  type Channel,
  type ChannelKind,
  type ErrorCode,
  type RealtimeRole,
} from "@futbolsa/contracts";
import type { RawData, WebSocket } from "ws";
import type { Clock } from "../clock/index.js";
import type { RealtimeAuthenticator, RealtimeIdentity } from "./authenticator.js";
import { meChannel, type BusSubscription, type EventBus, type Stream } from "./bus.js";
import { realtimeLimits, type RealtimeLimits } from "./limits.js";

export interface SessionDeps {
  bus: EventBus;
  authenticator: RealtimeAuthenticator;
  clock: Clock;
  /** Avisos que a sessão dá ao gateway, dono do registro de conexões. */
  hooks: {
    /** O login deu certo: a sessão agora tem dono. */
    onLogin(session: RealtimeSession): void;
    /** O cliente não escoa o envio e foi derrubado. */
    onSlowClient(session: RealtimeSession): void;
  };
}

/** Quem pode assinar cada tipo de canal. O `me` é sempre o do próprio usuário (a chave vem da identidade, nunca do cliente). */
type Access = "everyone" | "logged_in" | "admin";
const ACCESS: Record<ChannelKind, Access> = {
  season: "everyone",
  prices: "everyone",
  rankings: "everyone",
  club: "everyone",
  me: "logged_in",
  admin: "admin",
};

/**
 * O que uma conexão faz: lê as mensagens do cliente, confere o acesso a cada canal e liga
 * a conexão ao barramento. Uma sessão por `WebSocket`. As mensagens são tratadas uma de cada
 * vez, na ordem em que chegaram, mesmo que o `auth` demore.
 */
export class RealtimeSession {
  private identity: RealtimeIdentity | null = null;
  /** Já chegou alguma mensagem válida? Depois disso `auth` não vale mais. */
  private sawMessage = false;
  private readonly subscriptions = new Map<Channel, BusSubscription>();
  private queue: Promise<void> = Promise.resolve();
  private firstMessageTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private readonly limits: RealtimeLimits = realtimeLimits();
  /** Instantes (ms) das mensagens do último segundo, para limitar o ritmo. */
  private readonly recent: number[] = [];

  constructor(
    private readonly socket: WebSocket,
    private readonly deps: SessionDeps,
  ) {}

  get userId(): string | null {
    return this.identity?.userId ?? null;
  }

  get role(): RealtimeRole {
    return this.identity?.role ?? "visitor";
  }

  /** Começa a contar o prazo da primeira mensagem válida. */
  start(): void {
    this.firstMessageTimer = setTimeout(
      () => this.socket.close(CLOSE_CODES.authTimeout, "sem mensagem a tempo"),
      this.limits.firstMessageTimeoutMs,
    );
    this.firstMessageTimer.unref?.();
  }

  /** Uma mensagem chegou do cliente. */
  receive(data: RawData, isBinary: boolean): void {
    if (this.closed) return;
    if (this.overRate()) {
      this.close(CLOSE_CODES.rateLimited, "mensagens demais");
      return;
    }
    this.queue = this.queue.then(() => this.handle(data, isBinary)).catch(() => this.socket.terminate());
  }

  /** Fecha a conexão por decisão do servidor e solta tudo. */
  close(code: number, reason: string): void {
    this.dispose();
    this.socket.close(code, reason);
  }

  /** A conexão fechou: solta as assinaturas e o temporizador. */
  dispose(): void {
    this.closed = true;
    clearTimeout(this.firstMessageTimer);
    for (const subscription of this.subscriptions.values()) subscription.unsubscribe();
    this.subscriptions.clear();
  }

  private async handle(data: RawData, isBinary: boolean): Promise<void> {
    if (this.closed) return;
    const parsed = isBinary ? ({ ok: false } as const) : parseClientMessage(data.toString());
    if (!parsed.ok) return this.sendError("bad_message");

    const message = parsed.message;
    const isFirst = !this.sawMessage;
    this.sawMessage = true;
    clearTimeout(this.firstMessageTimer);

    switch (message.type) {
      case "auth":
        if (!isFirst) return this.sendError("auth_not_first");
        return this.login(message.token);
      case "subscribe":
        return this.subscribe(message.channel, message.since);
      case "unsubscribe":
        return this.unsubscribe(message.channel);
    }
  }

  private async login(token: string): Promise<void> {
    const result = await this.deps.authenticator.authenticate(token);
    if (this.closed) return;
    if (result.ok) {
      this.identity = result.identity;
      this.deps.hooks.onLogin(this);
      this.send("auth.ok", { role: result.identity.role });
      return;
    }
    this.sendAuthError(result.code);
    if (result.code === "invalid_token") this.socket.close(CLOSE_CODES.invalidToken, "token inválido");
  }

  private subscribe(raw: string, since: number | undefined): void {
    const channel = parseChannel(raw);
    if (!channel) return this.sendError("unknown_channel", raw);
    const denied = this.deny(channel);
    if (denied) return this.sendError(denied, channel);

    // assinar de novo o mesmo canal troca a assinatura (com o `since` novo)
    const previous = this.subscriptions.get(channel);
    if (!previous && this.subscriptions.size >= this.limits.maxSubscriptions) {
      return this.sendError("too_many_subscriptions", channel);
    }
    previous?.unsubscribe();
    const subscription = this.deps.bus.subscribe(this.streamOf(channel), (event) => this.sendFrame(event.frame), since);
    this.subscriptions.set(channel, subscription);

    // O barramento já registrou a assinatura; nada roda entre aqui e o fim do reenvio.
    this.send("subscribed", { channel, seq: subscription.seq, mode: subscription.mode });
    for (const event of subscription.replay) this.sendFrame(event.frame);
  }

  private unsubscribe(raw: string): void {
    const channel = parseChannel(raw);
    if (!channel) return this.sendError("unknown_channel", raw);
    this.subscriptions.get(channel)?.unsubscribe();
    this.subscriptions.delete(channel);
  }

  /** Por que a pessoa não pode assinar o canal, ou `null` se pode. */
  private deny(channel: Channel): ErrorCode | null {
    const access = ACCESS[channelKind(channel)];
    if (access === "everyone") return null;
    if (!this.identity) return "unauthorized";
    if (access === "admin" && this.identity.role !== "admin") return "forbidden";
    return null;
  }

  private streamOf(channel: Channel): Stream {
    return channel === "me" ? meChannel(this.identity!.userId) : channel;
  }

  private sendAuthError(code: AuthErrorCode): void {
    this.send("auth.error", { code });
  }

  private sendError(code: ErrorCode, channel?: string): void {
    this.send("error", channel === undefined ? { code } : { code, channel: channel.slice(0, 64) });
  }

  private send(type: string, data: unknown): void {
    this.sendFrame(
      JSON.stringify({ type, channel: SYSTEM_CHANNEL, seq: 0, at: this.deps.clock.now().toISOString(), data }),
    );
  }

  private sendFrame(frame: string): void {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(frame);
    // Cliente que não lê: o envio fica parado na memória do servidor. Derruba, e os outros nem sentem.
    // (Um quadro de fechamento não chegaria a quem não lê, então o socket é cortado de vez.)
    if (this.socket.bufferedAmount > this.limits.slowClientBytes) {
      this.dispose();
      this.socket.terminate();
      this.deps.hooks.onSlowClient(this);
    }
  }

  /** Passou de `maxMessagesPerSecond` mensagens no último segundo? */
  private overRate(): boolean {
    const now = this.deps.clock.now().getTime();
    this.recent.push(now);
    while (this.recent.length > 0 && now - this.recent[0]! >= 1_000) this.recent.shift();
    return this.recent.length > this.limits.maxMessagesPerSecond;
  }
}
