import type { AddressInfo } from "node:net";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import WebSocket from "ws";
import { createApp } from "../../src/app.js";

/** O endereço do site que os testes de tempo real usam como `WEB_ORIGIN`. */
export const WEB_ORIGIN = "http://localhost:3001";

export interface RunningApp {
  app: NestFastifyApplication;
  /** `ws://127.0.0.1:<porta sorteada>`, sem o caminho. */
  wsUrl: string;
  close(): Promise<void>;
}

/** Sobe a API de verdade numa porta sorteada, para o `ws` conectar nela. */
export async function startApp(): Promise<RunningApp> {
  process.env.WEB_ORIGIN = WEB_ORIGIN;
  const app = await createApp();
  await app.listen(0, "127.0.0.1");
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { app, wsUrl: `ws://127.0.0.1:${port}`, close: () => app.close() };
}

export interface ClosedInfo {
  code: number;
  reason: string;
}

/** Um cliente `ws` que guarda o que chega, para o teste esperar por mensagens e pelo fechamento. */
export class TestClient {
  readonly messages: unknown[] = [];
  readonly closed: Promise<ClosedInfo>;
  private waiting: Array<() => void> = [];

  private constructor(readonly socket: WebSocket) {
    socket.on("message", (raw) => {
      this.messages.push(JSON.parse(raw.toString()));
      this.waiting.splice(0).forEach((wake) => wake());
    });
    this.closed = new Promise((resolve) => {
      socket.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
  }

  /** Abre a conexão e espera ela ficar aberta. Falha se o servidor recusar o `upgrade`. */
  static async open(url: string, options: { origin?: string } = {}): Promise<TestClient> {
    const socket = new WebSocket(url, { origin: options.origin });
    const client = new TestClient(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return client;
  }

  /** Tenta abrir e devolve o status HTTP da recusa (ou `null` se abriu). */
  static async tryOpen(url: string, options: { origin?: string } = {}): Promise<number | null> {
    const socket = new WebSocket(url, { origin: options.origin });
    return new Promise((resolve) => {
      socket.once("open", () => {
        socket.close();
        resolve(null);
      });
      socket.once("unexpected-response", (_req, res) => {
        resolve(res.statusCode ?? 0);
        res.resume();
      });
      socket.once("error", () => resolve(-1));
    });
  }

  send(message: unknown): void {
    this.socket.send(typeof message === "string" ? message : JSON.stringify(message));
  }

  /** Espera a próxima mensagem ainda não lida (ou a que já chegou). */
  async next(timeoutMs = 2000): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    while (this.messages.length === 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("nenhuma mensagem chegou a tempo");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiting.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return this.messages.shift();
  }

  /** Espera um tempo e diz se nenhuma mensagem chegou nele. */
  async quiet(ms = 150): Promise<boolean> {
    const before = this.messages.length;
    await new Promise((resolve) => setTimeout(resolve, ms));
    return this.messages.length === before;
  }

  /** Manda uma mensagem e espera a próxima resposta. */
  async ask(message: unknown): Promise<any> {
    this.send(message);
    return this.next();
  }

  close(): Promise<ClosedInfo> {
    this.socket.close();
    return this.closed;
  }
}
