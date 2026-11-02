import { Injectable, Logger, Optional, type OnModuleDestroy } from "@nestjs/common";
import { channelAcceptsEvent, type Channel, type EventType } from "@futbolsa/contracts";
import type { ZodType } from "zod";
import { Clock } from "../clock/index.js";
import { Throttler, THROTTLE_RULES, type ThrottleRules } from "./throttle.js";
import { EventBus, type BusEvent, type BusListener, type BusSubscription, type Stream } from "./bus.js";

/** Quanto do passado cada canal guarda para a retomada (o que sobrar passa para a REST). */
export interface HistoryLimits {
  maxEvents: number;
  maxAgeMs: number;
}

export interface MemoryBusOptions {
  /** Canais públicos: os últimos 200 eventos ou 60 segundos. */
  publicHistory: HistoryLimits;
  /** O `me` de cada pessoa: os últimos 50 eventos ou 5 minutos. */
  meHistory: HistoryLimits;
  /** Os tipos de evento limitados a um por intervalo (T4). */
  throttle: ThrottleRules;
}

export const DEFAULT_BUS_OPTIONS: MemoryBusOptions = {
  publicHistory: { maxEvents: 200, maxAgeMs: 60_000 },
  meHistory: { maxEvents: 50, maxAgeMs: 300_000 },
  throttle: THROTTLE_RULES,
};

interface HistoryEntry extends BusEvent {
  at: number;
}

interface StreamState {
  limits: HistoryLimits;
  /** O `seq` inicial: o horário em milissegundos da primeira vez que o canal foi visto. */
  base: number;
  seq: number;
  history: HistoryEntry[];
  listeners: Set<BusListener>;
}

/**
 * Barramento de uma instância só. O `seq` de um canal começa no horário (em milissegundos) da
 * primeira vez que ele aparece depois da API subir e soma 1 a cada evento: depois de um
 * reinício ele é sempre maior que o de antes, e o cliente percebe o salto como buraco.
 */
@Injectable()
export class MemoryEventBus extends EventBus implements OnModuleDestroy {
  private readonly logger = new Logger(MemoryEventBus.name);
  private readonly streams = new Map<string, StreamState>();
  private readonly schemas = new Map<EventType, ZodType>();
  private readonly options: MemoryBusOptions;
  private readonly throttler: Throttler;

  constructor(
    private readonly clock: Clock,
    @Optional() options?: Partial<MemoryBusOptions>,
  ) {
    super();
    this.options = { ...DEFAULT_BUS_OPTIONS, ...options };
    this.throttler = new Throttler(this.options.throttle);
  }

  registerSchema(type: EventType, schema: ZodType): void {
    this.schemas.set(type, schema);
  }

  publish(stream: Stream, type: EventType, data: unknown): void {
    const { key, channel } = this.resolve(stream);
    if (!channelAcceptsEvent(channel, type)) {
      throw new Error(`o evento "${type}" não pertence ao canal "${channel}"`);
    }
    const schema = this.schemas.get(type);
    if (schema) {
      const parsed = schema.safeParse(data);
      if (!parsed.success) throw new Error(`conteúdo inválido para o evento "${type}": ${parsed.error.message}`);
    }

    const rule = this.throttler.rule(type, data);
    if (rule) {
      // o seq é dado na saída: o que a limitação descarta não deixa buraco
      this.throttler.submit(key, rule.windowKey, rule.intervalMs, () => this.emit(key, stream, channel, type, data));
    } else {
      this.emit(key, stream, channel, type, data);
    }
  }

  onModuleDestroy(): void {
    this.throttler.dispose();
  }

  private emit(key: string, stream: Stream, channel: Channel, type: EventType, data: unknown): void {
    const state = this.state(key, stream);
    const now = this.clock.now();
    state.seq += 1;
    // um quadro por evento, qualquer que seja o número de assinantes
    const frame = JSON.stringify({ type, channel, seq: state.seq, at: now.toISOString(), data });
    const event: HistoryEntry = { seq: state.seq, frame, at: now.getTime() };
    state.history.push(event);
    this.prune(state, now.getTime());

    for (const listener of [...state.listeners]) this.deliver(listener, event);
  }

  currentSeq(stream: Stream): number {
    const { key } = this.resolve(stream);
    return this.state(key, stream).seq;
  }

  subscribe(stream: Stream, listener: BusListener, since?: number): BusSubscription {
    const { key } = this.resolve(stream);
    const state = this.state(key, stream);
    this.prune(state, this.clock.now().getTime());

    let mode: BusSubscription["mode"] = "live";
    let replay: BusEvent[] = [];
    if (since !== undefined) {
      const oldest = state.history[0]?.seq;
      const covered = since === state.seq || (oldest !== undefined && since >= oldest - 1 && since < state.seq);
      if (since > state.seq || !covered) {
        mode = "resync";
      } else {
        mode = "resumed";
        replay = state.history.filter((e) => e.seq > since).map(({ seq, frame }) => ({ seq, frame }));
      }
    }

    // Tudo acima é síncrono: nenhum evento novo entra entre o reenvio e o registro abaixo.
    state.listeners.add(listener);
    return {
      mode,
      seq: state.seq,
      replay,
      unsubscribe: () => {
        state.listeners.delete(listener);
        this.release(key, state);
      },
    };
  }

  /** Quantos canais têm estado guardado agora. Serve aos testes. */
  trackedStreams(): number {
    return this.streams.size;
  }

  private resolve(stream: Stream): { key: string; channel: Channel } {
    if (typeof stream === "string") {
      if (stream === "me") throw new Error('o canal "me" é por pessoa: use meChannel(userId)');
      return { key: stream, channel: stream };
    }
    return { key: `me:${stream.userId}`, channel: "me" };
  }

  private state(key: string, stream: Stream): StreamState {
    let state = this.streams.get(key);
    if (!state) {
      const base = this.clock.now().getTime();
      const limits = typeof stream === "string" ? this.options.publicHistory : this.options.meHistory;
      state = { limits, base, seq: base, history: [], listeners: new Set() };
      this.streams.set(key, state);
    }
    return state;
  }

  /** Apaga o estado de um canal que ninguém assina e que nunca teve evento (canal inventado por um cliente). */
  private release(key: string, state: StreamState): void {
    if (state.listeners.size === 0 && state.seq === state.base && this.streams.get(key) === state) {
      this.streams.delete(key);
    }
  }

  private prune(state: StreamState, nowMs: number): void {
    const { maxEvents, maxAgeMs } = state.limits;
    let drop = Math.max(0, state.history.length - maxEvents);
    while (drop < state.history.length && nowMs - state.history[drop]!.at > maxAgeMs) drop++;
    if (drop > 0) state.history.splice(0, drop);
  }

  private deliver(listener: BusListener, event: BusEvent): void {
    try {
      listener(event);
    } catch (error) {
      this.logger.error(`assinante falhou no evento ${event.seq}`, error instanceof Error ? error.stack : String(error));
    }
  }
}
