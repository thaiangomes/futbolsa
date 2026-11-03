/** Atraso entre a publicação de um evento e o instante em que ele foi entregue ao socket de um assinante. */
export interface EventDelayStats {
  count: number;
  maxMs: number;
  avgMs: number;
}

export interface RealtimeStats {
  connections: number;
  /** Quantas conexões assinam cada canal (`me` e `admin` aparecem como tal, sem o dono). */
  subscriptions: Record<string, number>;
  /** Bytes parados no envio de todas as conexões. */
  bufferedBytes: number;
  slowClientsDropped: number;
  eventDelay: EventDelayStats;
}

/** Contadores do tempo real, desde que a API subiu. */
export class DelayRecorder {
  private count = 0;
  private total = 0;
  private max = 0;

  record(delayMs: number): void {
    const delay = Math.max(0, delayMs);
    this.count += 1;
    this.total += delay;
    if (delay > this.max) this.max = delay;
  }

  snapshot(): EventDelayStats {
    return { count: this.count, maxMs: this.max, avgMs: this.count === 0 ? 0 : this.total / this.count };
  }
}
