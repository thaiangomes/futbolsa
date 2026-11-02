import type { IncomingMessage } from "node:http";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import {
  WebSocketGateway,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
} from "@nestjs/websockets";
import { CLOSE_CODES, type RealtimeRole } from "@futbolsa/contracts";
import type { WebSocket } from "ws";
import { Clock } from "../clock/index.js";
import { RealtimeAuthenticator } from "./authenticator.js";
import { EventBus } from "./bus.js";
import { RealtimeLifecycle } from "./lifecycle.js";
import { MAX_MESSAGE_BYTES, realtimeLimits } from "./limits.js";
import { RealtimeSession } from "./protocol.js";
import { DelayRecorder, type RealtimeStats } from "./stats.js";

/** Quem está do outro lado de uma conexão. */
export interface ConnectionInfo {
  userId: string | null;
  role: RealtimeRole;
}

type VerifyDone = (allowed: boolean, code?: number, message?: string) => void;

/**
 * Só o site (WEB_ORIGIN) abre conexão; outro `Origin` é recusado no `upgrade`, antes de
 * virar WebSocket. Sem WEB_ORIGIN (desenvolvimento) vale tudo, como o CORS da API.
 * A variável é lida a cada conexão, não na carga do módulo.
 */
function verifyClient(info: { origin: string }, done: VerifyDone): void {
  const allowed = process.env.WEB_ORIGIN?.replace(/\/+$/, "");
  if (allowed && info.origin !== allowed) return done(false, 403, "Forbidden");
  done(true);
}

/**
 * Porta de entrada do tempo real: aceita a conexão em `/ws`. O protocolo (`auth`,
 * `subscribe`, eventos) é próprio, em envelope `{ type, channel, seq, at, data }`, e
 * entra por `handleConnection` direto no socket do `ws`; o `{ event, data }` do Nest não
 * é usado. O token nunca vem na URL: só na primeira mensagem. Mensagem acima de 4 KB
 * fecha com 1009 (`maxPayload` do `ws`).
 */
@WebSocketGateway({ path: "/ws", verifyClient, maxPayload: MAX_MESSAGE_BYTES })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy {
  private readonly sessions = new Map<WebSocket, RealtimeSession>();
  /** As sessões de cada pessoa, da mais antiga para a mais nova. */
  private readonly byUser = new Map<string, Set<RealtimeSession>>();
  private readonly delays = new DelayRecorder();
  private slowClientsDropped = 0;
  private lifecycle: RealtimeLifecycle | undefined;

  constructor(
    private readonly bus: EventBus,
    private readonly authenticator: RealtimeAuthenticator,
    private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    const { heartbeatMs, pingMs, maxAgeMs } = realtimeLimits();
    this.lifecycle = new RealtimeLifecycle(() => this.sessions.values(), this.clock, { heartbeatMs, pingMs, maxAgeMs });
    this.lifecycle.start();
  }

  /** Desligamento limpo: para os batimentos e fecha todas as conexões com 1001 (o cliente reconecta com recuo). */
  async onModuleDestroy(): Promise<void> {
    this.lifecycle?.stop();
    const closing = [...this.sessions.keys()].map(
      (socket) => new Promise<void>((resolve) => socket.once("close", () => resolve())),
    );
    for (const session of [...this.sessions.values()]) session.close(CLOSE_CODES.serverShutdown, "API desligando");
    // dá um instante para os quadros de fechamento saírem antes de o servidor cortar os sockets
    await Promise.race([Promise.all(closing), new Promise((resolve) => setTimeout(resolve, 1_000).unref?.())]);
  }

  handleConnection(socket: WebSocket, _request: IncomingMessage): void {
    if (this.sessions.size >= realtimeLimits().maxConnections) {
      socket.close(CLOSE_CODES.tryAgainLater, "servidor cheio");
      return;
    }
    const session = new RealtimeSession(socket, {
      bus: this.bus,
      authenticator: this.authenticator,
      clock: this.clock,
      hooks: {
        onLogin: (s) => this.registerUser(s),
        onSlowClient: () => {
          this.slowClientsDropped += 1;
        },
        onDelivered: (delayMs) => this.delays.record(delayMs),
      },
    });
    this.sessions.set(socket, session);
    socket.on("message", (data, isBinary) => session.receive(data, isBinary));
    session.start();
  }

  handleDisconnect(socket: WebSocket): void {
    const session = this.sessions.get(socket);
    if (!session) return;
    session.dispose();
    this.sessions.delete(socket);
    this.forgetUser(session);
  }

  /** Fecha todas as conexões da pessoa (conta excluída ou papel mudou) com 4403; o cliente reabre com o login atual. Devolve quantas fechou. */
  disconnectUser(userId: string): number {
    const sessions = [...(this.byUser.get(userId) ?? [])];
    for (const session of sessions) session.close(CLOSE_CODES.accountChanged, "conta alterada");
    return sessions.length;
  }

  /** O retrato do tempo real agora: conexões, assinaturas por canal, envio parado, clientes lentos e atraso dos eventos. */
  stats(): RealtimeStats {
    const subscriptions: Record<string, number> = {};
    let bufferedBytes = 0;
    for (const session of this.sessions.values()) {
      bufferedBytes += session.bufferedBytes;
      for (const channel of session.channels()) subscriptions[channel] = (subscriptions[channel] ?? 0) + 1;
    }
    return {
      connections: this.sessions.size,
      subscriptions,
      bufferedBytes,
      slowClientsDropped: this.slowClientsDropped,
      eventDelay: this.delays.snapshot(),
    };
  }

  /** As conexões abertas agora, sem o socket. Serve aos testes e, depois, às estatísticas. */
  snapshot(): ConnectionInfo[] {
    return [...this.sessions.values()].map((session) => ({ userId: session.userId, role: session.role }));
  }

  /** Guarda a sessão na lista da pessoa e, passando do limite, derruba a mais antiga. */
  private registerUser(session: RealtimeSession): void {
    const userId = session.userId;
    if (!userId) return;
    const sessions = this.byUser.get(userId) ?? new Set<RealtimeSession>();
    this.byUser.set(userId, sessions);
    sessions.add(session);
    const max = realtimeLimits().maxConnectionsPerUser;
    for (const oldest of sessions) {
      if (sessions.size <= max) break;
      sessions.delete(oldest);
      oldest.close(CLOSE_CODES.tryAgainLater, "conexões demais");
    }
  }

  private forgetUser(session: RealtimeSession): void {
    const userId = session.userId;
    if (!userId) return;
    const sessions = this.byUser.get(userId);
    sessions?.delete(session);
    if (sessions?.size === 0) this.byUser.delete(userId);
  }
}
