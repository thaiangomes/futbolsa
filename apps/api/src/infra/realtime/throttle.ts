import type { EventType } from "@futbolsa/contracts";

/** Um tipo de evento limitado a um por intervalo, por canal (e, se `key` existir, por chave do conteúdo). */
export interface ThrottleRule {
  intervalMs: number;
  /** Separa as janelas dentro do mesmo canal; sem ela, uma janela por canal. */
  key?: (data: unknown) => string | undefined;
}

export type ThrottleRules = Partial<Record<EventType, ThrottleRule>>;

function tickerOf(data: unknown): string | undefined {
  const ticker = (data as { ticker?: unknown } | null)?.ticker;
  return typeof ticker === "string" ? ticker : undefined;
}

/** A tabela da arquitetura: livro 4 por segundo por clube, preço 1 por segundo por clube, parcial do ranking a cada 10 s. */
export const THROTTLE_RULES: ThrottleRules = {
  book: { intervalMs: 250 },
  price: { intervalMs: 1_000, key: tickerOf },
  "rankings.live": { intervalMs: 10_000 },
};

interface Window {
  timer: ReturnType<typeof setTimeout>;
  /** O evento mais recente que chegou durante a janela; os anteriores a ele já não valem. */
  pending?: () => void;
}

/**
 * O primeiro evento de uma rajada sai na hora; os seguintes esperam o fim do intervalo e só o
 * mais recente sai (o último sempre sai). Quem decide o `seq` é a hora da saída, então o
 * que foi descartado não deixa buraco. Só usa temporizadores: nenhuma leitura de relógio.
 */
export class Throttler {
  private readonly windows = new Map<string, Window>();

  constructor(private readonly rules: ThrottleRules) {}

  /** Janela e intervalo de um evento, ou `null` se o tipo não é limitado. */
  rule(type: EventType, data: unknown): { windowKey: string; intervalMs: number } | null {
    const rule = this.rules[type];
    if (!rule) return null;
    return { windowKey: `${type}|${rule.key?.(data) ?? ""}`, intervalMs: rule.intervalMs };
  }

  /** Emite agora, se a janela está livre, ou guarda como o mais recente. `scope` identifica o canal. */
  submit(scope: string, windowKey: string, intervalMs: number, emit: () => void): void {
    const key = `${scope}|${windowKey}`;
    const open = this.windows.get(key);
    if (open) {
      open.pending = emit;
      return;
    }
    try {
      emit();
    } finally {
      this.open(key, intervalMs);
    }
  }

  /** Cancela as janelas abertas e descarta o que esperava. */
  dispose(): void {
    for (const window of this.windows.values()) clearTimeout(window.timer);
    this.windows.clear();
  }

  private open(key: string, intervalMs: number): void {
    const timer = setTimeout(() => this.fire(key, intervalMs), intervalMs);
    timer.unref?.();
    this.windows.set(key, { timer });
  }

  private fire(key: string, intervalMs: number): void {
    const window = this.windows.get(key);
    if (!window) return;
    this.windows.delete(key);
    if (!window.pending) return;
    try {
      window.pending();
    } finally {
      this.open(key, intervalMs);
    }
  }
}
