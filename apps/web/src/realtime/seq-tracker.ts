/** O que fazer com um evento que chegou. */
export type SeqDecision =
  /** É o próximo: aplicar. */
  | "apply"
  /** Já visto (repetido ou antigo): descartar. */
  | "stale"
  /** Faltou algum no meio: não aplicar, recarregar pela REST. Vale também para tudo que chegar até a recarga. */
  | "gap";

/**
 * Decide, evento a evento, se ele pode ser aplicado: só o `último + 1`. Repetido e antigo são
 * descartados; um salto é buraco, e depois dele nada é aplicado até `reset` (a recarga pela
 * REST), para o 3 que chega depois do 4 não ser aplicado fora de ordem.
 */
export class SeqTracker {
  private lastSeq: number | null;
  private gapped = false;

  constructor(initialSeq: number | null = null) {
    this.lastSeq = initialSeq;
  }

  /** O `seq` do último evento aplicado (ou da carga), ou `null` se ainda não há base. */
  get last(): number | null {
    return this.lastSeq;
  }

  /** Houve buraco desde o último `reset`? */
  get hasGap(): boolean {
    return this.gapped;
  }

  accept(seq: number): SeqDecision {
    if (this.gapped) return "gap";
    if (this.lastSeq === null) {
      this.lastSeq = seq;
      return "apply";
    }
    if (seq <= this.lastSeq) return "stale";
    if (seq === this.lastSeq + 1) {
      this.lastSeq = seq;
      return "apply";
    }
    this.gapped = true;
    return "gap";
  }

  /** A carga pela REST terminou: o estado agora vale até este `seq`. */
  reset(seq: number | null): void {
    this.lastSeq = seq;
    this.gapped = false;
  }
}
