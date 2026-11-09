import type { Database } from "./client.js";

/** A transação do Drizzle que `db.transaction` entrega. */
export type DrizzleTx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Trava pedida fora da ordem temporada → clubes → eventos de pagamento → carteiras → tesouraria. Erro de
 * programação.
 */
export class LockOrderError extends Error {
  readonly code = "lock_order";
  constructor(message: string) {
    super(message);
    this.name = "LockOrderError";
  }
}

type WalletKey = readonly [treasury: 0 | 1, id: number];

const compareKeys = (a: WalletKey, b: WalletKey) => a[0] - b[0] || a[1] - b[1];

/**
 * O que a transação já travou, para recusar uma trava fora da ordem. A ordem é
 * sempre a mesma em todo o jogo (Arquitetura da Fase 1, decisão 4): a temporada;
 * os clubes por ticker; as linhas dos eventos de pagamento por id (P3 da F12, entre
 * os clubes e as carteiras); as carteiras de jogadores e bots por id; a tesouraria
 * por último. Assim duas transações nunca esperam uma pela outra em círculo.
 */
export class LockState {
  private season?: { id: number; mode: "share" | "update" };
  private clubSeasonId?: number;
  private readonly clubs = new Set<string>();
  private lastTicker?: string;
  private readonly payoutEvents = new Map<number, "share" | "update">();
  private lastPayoutEvent?: number;
  private readonly wallets = new Map<number, boolean>();
  private lastWallet?: WalletKey;

  checkSeason(seasonId: number, mode: "share" | "update"): void {
    if (this.season) {
      if (this.season.id !== seasonId) throw new LockOrderError("uma transação trava uma temporada só");
      if (this.season.mode === "share" && mode === "update") {
        throw new LockOrderError("a trava da temporada não sobe de compartilhada para exclusiva");
      }
      return;
    }
    if (this.clubs.size > 0 || this.payoutEvents.size > 0 || this.wallets.size > 0) {
      throw new LockOrderError("a temporada é travada antes dos clubes, dos eventos de pagamento e das carteiras");
    }
  }

  markSeason(seasonId: number, mode: "share" | "update"): void {
    if (!this.season) this.season = { id: seasonId, mode };
  }

  /** Confere e devolve os tickers ainda não travados, já em ordem. */
  checkClubs(seasonId: number, sortedTickers: readonly string[]): string[] {
    if (this.clubSeasonId !== undefined && this.clubSeasonId !== seasonId) {
      throw new LockOrderError("uma transação trava clubes de uma temporada só");
    }
    const fresh = sortedTickers.filter((t) => !this.clubs.has(t));
    if (fresh.length === 0) return fresh;
    if (this.payoutEvents.size > 0) throw new LockOrderError(`clube ${fresh[0]} travado depois de um evento de pagamento`);
    if (this.wallets.size > 0) throw new LockOrderError(`clube ${fresh[0]} travado depois de uma carteira`);
    if (this.lastTicker !== undefined && fresh[0]! < this.lastTicker) {
      throw new LockOrderError(`clube ${fresh[0]} travado depois de ${this.lastTicker}, fora da ordem de ticker`);
    }
    return fresh;
  }

  markClubs(seasonId: number, sortedTickers: readonly string[]): void {
    this.clubSeasonId = seasonId;
    for (const t of sortedTickers) {
      this.clubs.add(t);
      if (this.lastTicker === undefined || t > this.lastTicker) this.lastTicker = t;
    }
  }

  isClubLocked(ticker: string): boolean {
    return this.clubs.has(ticker);
  }

  /**
   * Confere a ordem dos eventos de pagamento ainda não travados (`sortedIds` já em ordem de id): depois dos
   * clubes e antes das carteiras; e a trava de um evento não sobe de compartilhada para exclusiva (duas
   * transações com `FOR SHARE` subindo para `FOR UPDATE` esperariam uma pela outra).
   */
  checkPayoutEvents(sortedIds: readonly number[], mode: "share" | "update"): void {
    for (const id of sortedIds) {
      if (this.payoutEvents.get(id) === "share" && mode === "update") {
        throw new LockOrderError(`a trava do evento de pagamento ${id} não sobe de compartilhada para exclusiva`);
      }
    }
    const fresh = sortedIds.filter((id) => !this.payoutEvents.has(id));
    if (fresh.length === 0) return;
    if (this.wallets.size > 0) throw new LockOrderError(`evento de pagamento ${fresh[0]} travado depois de uma carteira`);
    if (this.lastPayoutEvent !== undefined && fresh[0]! < this.lastPayoutEvent) {
      throw new LockOrderError(`evento de pagamento ${fresh[0]} travado depois do ${this.lastPayoutEvent}, fora da ordem de id`);
    }
  }

  markPayoutEvents(sortedIds: readonly number[], mode: "share" | "update"): void {
    for (const id of sortedIds) {
      if (!this.payoutEvents.has(id)) this.payoutEvents.set(id, mode);
      if (this.lastPayoutEvent === undefined || id > this.lastPayoutEvent) this.lastPayoutEvent = id;
    }
  }

  isPayoutEventLocked(id: number): boolean {
    return this.payoutEvents.has(id);
  }

  /** Confere a ordem das carteiras ainda não travadas (`keys` já ordenadas). */
  checkWallets(keys: readonly WalletKey[]): void {
    const fresh = keys.filter(([, id]) => !this.wallets.has(id));
    if (fresh.length === 0 || this.lastWallet === undefined) return;
    if (compareKeys(fresh[0]!, this.lastWallet) < 0) {
      const [treasury, id] = fresh[0]!;
      throw new LockOrderError(
        `carteira ${id}${treasury ? " (tesouraria)" : ""} travada depois da ${this.lastWallet[1]}, fora da ordem`,
      );
    }
  }

  markWallets(keys: readonly WalletKey[]): void {
    for (const key of keys) {
      this.wallets.set(key[1], key[0] === 1);
      if (this.lastWallet === undefined || compareKeys(key, this.lastWallet) > 0) this.lastWallet = key;
    }
  }

  /**
   * Carteira criada nesta transação: o `INSERT` já segura a linha e ninguém mais a
   * vê antes do `COMMIT`, então ela entra como travada sem conferir a ordem.
   */
  registerNewWallet(id: number, treasury: boolean): void {
    this.wallets.set(id, treasury);
  }

  isWalletLocked(id: number): boolean {
    return this.wallets.has(id);
  }
}

/** O contexto de uma transação: o banco, as travas já tomadas e o que roda depois do `COMMIT`. */
export class Tx {
  readonly locks = new LockState();
  private readonly callbacks: Array<() => void | Promise<void>> = [];

  constructor(readonly db: DrizzleTx) {}

  /** Roda depois do `COMMIT` (os eventos do WebSocket). Some se a transação desfaz. */
  afterCommit(fn: () => void | Promise<void>): void {
    this.callbacks.push(fn);
  }

  /** @internal */
  takeCallbacks(): Array<() => void | Promise<void>> {
    return this.callbacks.splice(0);
  }
}

/** Repetições depois da primeira tentativa (decisão 4 da arquitetura). */
export const MAX_RETRIES = 3;

/** *Deadlock* e conflito de serialização: o Postgres desfez, e repetir é seguro. */
const RETRYABLE = new Set(["40P01", "40001"]);

export interface TransactionOptions {
  /** Chamado a cada repetição, com o número dela e o código do Postgres. */
  onRetry?: (attempt: number, code: string) => void;
  /** Erro num `afterCommit`: a transação já foi gravada, então não volta como erro. */
  onAfterCommitError?: (error: unknown) => void;
}

/** O código SQLSTATE do erro do Postgres, procurando também nas causas (o Drizzle embrulha). */
export function pgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Roda `fn` numa transação (`READ COMMITTED`; a ordem vem das travas explícitas).
 * Se o Postgres abortar por *deadlock* ou conflito de serialização, repete a
 * função inteira até `MAX_RETRIES` vezes, com uma espera curta e sorteada. Os
 * `afterCommit` rodam uma vez, só depois do `COMMIT` da tentativa que deu certo.
 */
export async function withTransaction<T>(
  db: Database,
  fn: (tx: Tx) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let tx: Tx | undefined;
    let result: T;
    try {
      result = await db.transaction(
        async (dtx) => {
          tx = new Tx(dtx);
          return fn(tx);
        },
        { isolationLevel: "read committed" },
      );
    } catch (error) {
      const code = pgErrorCode(error);
      if (code && RETRYABLE.has(code) && attempt < MAX_RETRIES) {
        options.onRetry?.(attempt + 1, code);
        await pause(5 + Math.random() * 20 * (attempt + 1));
        continue;
      }
      throw error;
    }
    for (const callback of tx!.takeCallbacks()) {
      try {
        await callback();
      } catch (error) {
        (options.onAfterCommitError ?? console.error)(error);
      }
    }
    return result;
  }
}
