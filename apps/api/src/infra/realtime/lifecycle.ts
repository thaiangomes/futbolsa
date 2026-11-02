import { CLOSE_CODES } from "@futbolsa/contracts";
import type { Clock } from "../clock/index.js";

/** O que o ciclo de vida precisa saber de uma conexão. */
export interface LifecycleSession {
  /** Instante (ms) do login, ou `null` para o visitante. */
  readonly loggedInAt: number | null;
  sendHeartbeat(): void;
  ping(): void;
  close(code: number, reason: string): void;
}

export interface LifecycleConfig {
  /** De quanto em quanto tempo o servidor manda `heartbeat` (o navegador não enxerga o `ping`). */
  heartbeatMs: number;
  /** De quanto em quanto tempo o servidor manda `ping` e derruba quem não respondeu ao anterior. */
  pingMs: number;
  /** Vida máxima de uma conexão autenticada; depois disso o cliente reabre com token novo. */
  maxAgeMs: number;
}

/**
 * Os batimentos do servidor: `heartbeat` para o cliente perceber conexão morta, `ping` para o
 * servidor perceber, e o limite de vida da conexão autenticada (o token só é conferido na
 * abertura; o limite impede que quem saiu do jogo continue recebendo o `me`).
 */
export class RealtimeLifecycle {
  private timers: Array<ReturnType<typeof setInterval>> = [];

  constructor(
    private readonly sessions: () => Iterable<LifecycleSession>,
    private readonly clock: Clock,
    private readonly config: LifecycleConfig,
  ) {}

  start(): void {
    this.stop();
    this.timers = [
      setInterval(() => this.heartbeat(), this.config.heartbeatMs),
      setInterval(() => this.ping(), this.config.pingMs),
    ];
    for (const timer of this.timers) timer.unref?.();
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  /** Um batimento: fecha as conexões que passaram da vida máxima e manda `heartbeat` às outras. */
  private heartbeat(): void {
    const now = this.clock.now().getTime();
    for (const session of [...this.sessions()]) {
      if (session.loggedInAt !== null && now - session.loggedInAt >= this.config.maxAgeMs) {
        session.close(CLOSE_CODES.sessionExpired, "sessão expirada");
      } else {
        session.sendHeartbeat();
      }
    }
  }

  private ping(): void {
    for (const session of [...this.sessions()]) session.ping();
  }
}
