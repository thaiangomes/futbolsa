import type { IncomingMessage } from "node:http";
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
import { MAX_MESSAGE_BYTES, realtimeLimits } from "./limits.js";
import { RealtimeSession } from "./protocol.js";

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
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly sessions = new Map<WebSocket, RealtimeSession>();
  /** As sessões de cada pessoa, da mais antiga para a mais nova. */
  private readonly byUser = new Map<string, Set<RealtimeSession>>();
  private slowClientsDropped = 0;

  constructor(
    private readonly bus: EventBus,
    private readonly authenticator: RealtimeAuthenticator,
    private readonly clock: Clock,
  ) {}

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

  /** Contadores da vida do tempo real (a T7 acrescenta o resto). */
  stats() {
    return { connections: this.sessions.size, slowClientsDropped: this.slowClientsDropped };
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
