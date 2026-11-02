import type { IncomingMessage } from "node:http";
import {
  WebSocketGateway,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
} from "@nestjs/websockets";
import type { RealtimeRole } from "@futbolsa/contracts";
import type { WebSocket } from "ws";
import { Clock } from "../clock/index.js";
import { RealtimeAuthenticator } from "./authenticator.js";
import { EventBus } from "./bus.js";
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
 * é usado. O token nunca vem na URL: só na primeira mensagem.
 */
@WebSocketGateway({ path: "/ws", verifyClient })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly sessions = new Map<WebSocket, RealtimeSession>();

  constructor(
    private readonly bus: EventBus,
    private readonly authenticator: RealtimeAuthenticator,
    private readonly clock: Clock,
  ) {}

  handleConnection(socket: WebSocket, _request: IncomingMessage): void {
    const session = new RealtimeSession(socket, {
      bus: this.bus,
      authenticator: this.authenticator,
      clock: this.clock,
    });
    this.sessions.set(socket, session);
    socket.on("message", (data, isBinary) => session.receive(data, isBinary));
    session.start();
  }

  handleDisconnect(socket: WebSocket): void {
    this.sessions.get(socket)?.dispose();
    this.sessions.delete(socket);
  }

  /** As conexões abertas agora, sem o socket. Serve aos testes e, depois, às estatísticas. */
  snapshot(): ConnectionInfo[] {
    return [...this.sessions.values()].map((session) => ({ userId: session.userId, role: session.role }));
  }
}
