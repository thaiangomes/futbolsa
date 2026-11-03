import type { Channel, EventEnvelope } from "@futbolsa/contracts";
import type { ChannelHandlers } from "./client";
import { SeqTracker } from "./seq-tracker";

/** Quanto esperar antes de tentar a carga de novo depois de uma falha. */
const RETRY_AFTER_ERROR_MS = 3_000;
/** Quantos eventos guardar durante uma carga; passou disso, descarta e recarrega depois. */
const MAX_BUFFERED_EVENTS = 2_000;

export interface SyncedChannelOptions<S> {
  /** O que o canal precisa do cliente: assinar. */
  client: { subscribe(channel: Channel, handlers: ChannelHandlers): () => void };
  channel: Channel;
  /** Carrega o estado pela REST. O `seq` tem que ter sido lido **antes** do banco (assim nada se perde entre a foto e o fluxo). */
  load(): Promise<{ state: S; seq: number }>;
  /** Aplica um evento ao estado, sem mutar. Aplicar duas vezes o mesmo evento tem que dar o mesmo estado. */
  apply(state: S, event: EventEnvelope): S;
}

export type SyncedStatus = "idle" | "loading" | "ready" | "error";

export interface SyncedSnapshot<S> {
  status: SyncedStatus;
  /** O estado atual; durante uma recarga continua o último conhecido. */
  state: S | null;
}

/**
 * Uma tela com estado e eventos (livro, carteira, parcial do ranking). A regra, sempre a mesma:
 * 1. assina o canal e **guarda** os eventos, sem aplicar;
 * 2. carrega pela REST (estado + `seq` lido antes do banco);
 * 3. aplica só os guardados com `seq` maior que o da carga, em ordem;
 * 4. dali em diante cada evento tem que ser o último `seq` + 1: repetido é descartado, buraco recarrega.
 * Na reconexão o cliente reassina com `since` = último `seq` aplicado; `resync` recarrega.
 *
 * Funciona como uma "loja" (`getSnapshot` + `subscribe`) para o React ler com `useSyncExternalStore`.
 */
export class SyncedChannel<S> {
  private snapshot: SyncedSnapshot<S> = { status: "idle", state: null };
  private readonly listeners = new Set<() => void>();
  private readonly tracker = new SeqTracker();

  private unsubscribe: (() => void) | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  /** Cada carga tem um número; o resultado de uma carga que não é a última é ignorado. */
  private loadId = 0;
  private loading = false;
  private buffer: EventEnvelope[] = [];

  constructor(private readonly options: SyncedChannelOptions<S>) {}

  getSnapshot = (): SyncedSnapshot<S> => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Assina o canal e faz a primeira carga. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.unsubscribe = this.options.client.subscribe(this.options.channel, {
      onEvent: (event) => this.onEvent(event),
      onSubscribed: ({ mode }) => {
        if (mode === "resync") this.reload();
      },
      since: () => (this.snapshot.state === null ? undefined : (this.tracker.last ?? undefined)),
    });
    this.reload();
  }

  /** Para de vez: solta a assinatura, cancela a carga e a retentativa. */
  stop(): void {
    this.running = false;
    this.loadId += 1;
    this.loading = false;
    this.buffer = [];
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.snapshot = { status: "idle", state: null };
  }

  /** Recarrega pela REST: guarda os eventos que chegarem enquanto isso. */
  reload(): void {
    if (!this.running) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const id = ++this.loadId;
    this.loading = true;
    this.setSnapshot({ status: "loading", state: this.snapshot.state });
    this.options.load().then(
      (loaded) => {
        if (id === this.loadId) this.onLoaded(loaded.state, loaded.seq);
      },
      () => {
        if (id !== this.loadId || !this.running) return;
        this.loading = false;
        this.setSnapshot({ status: "error", state: this.snapshot.state });
        this.retryTimer = setTimeout(() => this.reload(), RETRY_AFTER_ERROR_MS);
      },
    );
  }

  private onLoaded(loaded: S, seq: number): void {
    this.loading = false;
    this.tracker.reset(seq);
    let state = loaded;
    const buffered = this.buffer;
    this.buffer = [];
    for (const event of buffered) {
      const decision = this.tracker.accept(event.seq);
      if (decision === "apply") state = this.options.apply(state, event);
      else if (decision === "gap") {
        // faltou evento no meio dos guardados: o que foi aplicado vale, e a recarga corrige o resto
        this.setSnapshot({ status: "ready", state });
        this.reload();
        return;
      }
    }
    this.setSnapshot({ status: "ready", state });
  }

  private onEvent(event: EventEnvelope): void {
    if (!this.running) return;
    // com a carga falhada, a retentativa já está agendada: guarda em vez de recarregar a cada evento
    if (this.loading || this.snapshot.status === "error") {
      if (this.buffer.length < MAX_BUFFERED_EVENTS) this.buffer.push(event);
      return;
    }
    const decision = this.tracker.accept(event.seq);
    if (decision === "apply") {
      this.setSnapshot({ status: "ready", state: this.options.apply(this.snapshot.state as S, event) });
    } else if (decision === "gap") {
      this.buffer = [event];
      this.reload();
    }
  }

  private setSnapshot(next: SyncedSnapshot<S>): void {
    const current = this.snapshot;
    if (current.status === next.status && Object.is(current.state, next.state)) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
