import type { IncomingMessage } from "node:http";
import {
  WebSocketGateway,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
} from "@nestjs/websockets";
import type { WebSocket } from "ws";

/** Quem está do outro lado de uma conexão. Sem login (T1), todo mundo é visitante. */
export interface ConnectionInfo {
  userId: string | null;
  role: "visitor" | "player" | "admin";
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
 * é usado. O token nunca vem na URL: só na primeira mensagem (T5).
 */
@WebSocketGateway({ path: "/ws", verifyClient })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly connections = new Map<WebSocket, ConnectionInfo>();

  handleConnection(socket: WebSocket, _request: IncomingMessage): void {
    this.connections.set(socket, { userId: null, role: "visitor" });
  }

  handleDisconnect(socket: WebSocket): void {
    this.connections.delete(socket);
  }

  /** As conexões abertas agora, sem o socket. Serve aos testes e, depois, às estatísticas. */
  snapshot(): ConnectionInfo[] {
    return [...this.connections.values()].map((info) => ({ ...info }));
  }
}
