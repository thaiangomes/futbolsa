/**
 * Medidores (T15 da F16). A porta `Metrics` não faz nada por padrão: em produção e nos testes comuns o objeto ativo é o
 * `NoopMetrics`, e o código que mede nem lê o relógio (`enabled` é falso). O servidor de carga troca por uma
 * implementação que guarda histogramas (`carga/medidores.ts`). Nada aqui muda o comportamento das travas: só observa.
 */

/** Qual trava foi medida. `wallet_treasury` é o pedido de carteiras que inclui a tesouraria (a última da ordem, a mais disputada). */
export type LockKind = "season" | "club" | "payout_event" | "wallet" | "wallet_treasury";

export interface Metrics {
  /** Falso no `NoopMetrics`: quem mede só chama o relógio quando é verdadeiro. */
  readonly enabled: boolean;
  /** Quanto tempo uma instrução de trava esperou até ter as linhas (ms). `key` é o ticker no clube; vazio nos demais. */
  lockWait(kind: LockKind, key: string | undefined, ms: number): void;
  /** Quanto tempo a trava ficou segura, da aquisição ao `COMMIT` (ms). */
  lockHeld(kind: LockKind, key: string | undefined, ms: number): void;
  /** A transação foi repetida depois de *deadlock* (`40P01`) ou conflito de serialização (`40001`). */
  retry(code: string): void;
  /** As repetições acabaram e o erro subiu. */
  retryExhausted(code: string): void;
  /** Atraso de um evento do WebSocket, da publicação (depois do `COMMIT`) até o envio ao socket (ms). */
  eventDelay(ms: number): void;
}

export class NoopMetrics implements Metrics {
  readonly enabled = false;
  lockWait(): void {}
  lockHeld(): void {}
  retry(): void {}
  retryExhausted(): void {}
  eventDelay(): void {}
}

const NOOP = new NoopMetrics();
let active: Metrics = NOOP;

/** Os medidores em uso agora. */
export function metrics(): Metrics {
  return active;
}

/** Troca os medidores (só o servidor de carga e os testes); `undefined` volta ao padrão sem efeito. */
export function setMetrics(next: Metrics | undefined): void {
  active = next ?? NOOP;
}
