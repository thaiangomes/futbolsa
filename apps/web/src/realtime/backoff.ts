const MIN_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;
/** A espera real é sorteada entre esta fração do valor e o valor inteiro. */
const JITTER_FLOOR = 0.5;

/**
 * Quanto esperar antes de reconectar: de 1 a 30 segundos, dobrando a cada falha, com sorteio
 * de 50% a 100% do valor. O sorteio espalha a volta de milhares de pessoas depois de a API
 * reiniciar, em vez de um pico no mesmo segundo.
 */
export class Backoff {
  private failures = 0;

  /** A próxima espera em milissegundos; chamar de novo conta mais uma falha. */
  next(random: () => number = Math.random): number {
    const full = Math.min(MAX_DELAY_MS, MIN_DELAY_MS * 2 ** Math.min(this.failures, 16));
    this.failures += 1;
    return Math.round(full * (JITTER_FLOOR + (1 - JITTER_FLOOR) * random()));
  }

  /** A conexão se manteve aberta: a próxima falha volta a esperar 1 segundo. */
  reset(): void {
    this.failures = 0;
  }
}
