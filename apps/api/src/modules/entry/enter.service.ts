import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { EnterResult, EntryModeChoice } from "@futbolsa/contracts";
import { ENTRY_TOTAL, entryQuote, entryWindow, referencePrice } from "@futbolsa/engine";
import { Clock } from "../../infra/clock/index.js";
import { DB, lockClubs, lockSeason, lockWallets, pgErrorCode, withTransaction, type Database, type DrizzleTx, type TransactionOptions } from "../../infra/db/index.js";
import { clubs, seasonClubs, users, walletEntries, wallets } from "../../infra/db/schema/index.js";
import { currentSeason } from "../admin/current-season.js";
import { PortfolioLedger } from "../portfolio/index.js";
import type { Movement, PostManyResult, PostResult } from "../portfolio/ledger/index.js";
import { findWallet, ipoSettled, loadSerieAMatches, seasonGate, type EntryOwner } from "./availability.js";
import type { BotEntry } from "./bot-entry.js";
import { EntryGate } from "./entry-gate.js";
import { EntryEvents } from "./events.js";
import { entryError } from "./errors.js";

type Db = Database | DrizzleTx;

/** O resultado da entrada e se a carteira nasceu agora (201) ou já existia (200, `repeated`). */
export interface EnterOutcome {
  result: EnterResult;
  created: boolean;
  walletId: number;
}

/** Opções de `enter` (os testes contam as repetições por *deadlock* com `onRetry`). */
export interface EnterOptions {
  transaction?: TransactionOptions;
}

/**
 * Tempo máximo esperando cada trava e tempo máximo de cada comando (P2). O `statement_timeout` do Postgres vale por
 * comando, não pela transação inteira: o que segura a duração entre o relógio (passo 6) e o `COMMIT` é que, depois
 * da trava dos clubes, só a trava da tesouraria (só caixa) ainda pode esperar, e no máximo o `lock_timeout`.
 */
const LOCK_TIMEOUT = "5s";
const STATEMENT_TIMEOUT = "15s";

/**
 * A entrada no meio da temporada (F11): emite N ações de cada clube, abre a carteira e grava o extrato, tudo ou nada,
 * com os clubes travados pelo menor tempo possível. O desenho da transação, passo a passo, está no Plano da entrada
 * no meio da temporada ("A transação, passo a passo") e a ordem das travas na Arquitetura da Fase 1 (decisão 4).
 */
@Injectable()
export class EntryService implements BotEntry {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly clock: Clock,
    private readonly ledger: PortfolioLedger,
    private readonly gate: EntryGate,
    private readonly events: EntryEvents,
  ) {}

  /**
   * `POST /entry`. Repetível sem chave (P6): quem já entrou com o mesmo modo recebe o mesmo resultado, com `repeated`;
   * com outro modo, `already_entered` e nada muda. O semáforo (P2) fica de fora da transação.
   */
  async enter(owner: EntryOwner, mode: EntryModeChoice, options: EnterOptions = {}): Promise<EnterOutcome> {
    if (owner.type === "user" && owner.status !== "active") throw entryError("account_blocked");
    if (owner.type === "bot" && mode !== "index") throw new Error("bot só entra com a carteira índice");
    // Atalho sem trava: quem já entrou (duplo clique, nova tentativa) não espera nenhuma fila nem trava.
    const known = await this.answerIfEntered(this.db, owner, mode);
    if (known) return known;
    try {
      // o atalho se repete já na vez da fila: o clique repetido não trava os clubes só para cair no passo 8
      return await this.gate.run(async () => (await this.answerIfEntered(this.db, owner, mode)) ?? this.transaction(owner, mode, options));
    } catch (error) {
      const code = pgErrorCode(error);
      // a trava não saiu em 5 s, ou um comando passou de 15 s: desfeito, e a tela tenta de novo
      if (code === "55P03" || code === "57014") throw entryError("entry_busy");
      // chave repetida: outra chamada da mesma pessoa gravou a carteira primeiro; vale a resposta do passo 8
      if (code === "23505") {
        const answer = await this.answerIfEntered(this.db, owner, mode);
        if (answer) return answer;
      }
      throw error;
    }
  }

  /**
   * A entrada de um bot ligado depois do IPO (Admin, critério 30): sempre a carteira índice, sem escolha, com a mesma
   * transação, a mesma janela e a mesma repetição da pessoa. Bot não tem login: sem aviso no WebSocket.
   */
  enterBot(botId: number, options: EnterOptions = {}): Promise<EnterOutcome> {
    return this.enter({ type: "bot", botId }, "index", options);
  }

  private transaction(owner: EntryOwner, mode: EntryModeChoice, options: EnterOptions): Promise<EnterOutcome> {
    return withTransaction(this.db, async (tx) => {
      // 1. as esperas têm limite: a entrada nunca fica pendurada atrás de uma transação travada
      await tx.db.execute(
        sql`select set_config('lock_timeout', ${LOCK_TIMEOUT}, true), set_config('statement_timeout', ${STATEMENT_TIMEOUT}, true)`,
      );
      // 2. a temporada, compartilhada: o fim da negociação e o fechamento do IPO (exclusivos) esperam a entrada
      const current = await currentSeason(tx.db);
      if (!current) throw entryError("entry_not_open");
      const season = await lockSeason(tx, current.id, "share");
      this.refuse(seasonGate(season, true), season.suspendedReason);
      // 3. os jogos da Série A, antes da trava dos clubes: a leitura não faz parte da trava
      const serieA = await loadSerieAMatches(tx.db, season.id);
      // 4. os clubes listados (depois da abertura do IPO a lista não muda)
      const listed = await tx.db
        .select({ ticker: clubs.ticker })
        .from(seasonClubs)
        .innerJoin(clubs, eq(clubs.id, seasonClubs.clubId))
        .where(eq(seasonClubs.seasonId, season.id));
      const tickers = listed.map((l) => l.ticker!);
      const [treasury] = mode === "cash" ? await tx.db.select({ id: wallets.id }).from(wallets).where(and(eq(wallets.seasonId, season.id), eq(wallets.ownerType, "treasury"))) : [];
      if (mode === "cash" && !treasury) throw new Error(`temporada ${season.id} sem tesouraria`);

      // 5. TODOS os clubes, em ordem de ticker: daqui até o COMMIT o mercado todo espera
      const locked = await lockClubs(tx, season.id, tickers);
      // 6. o relógio só depois das travas (P3): o horário da carteira e do extrato não fica antes de um fechamento
      //    que aconteceu enquanto esperávamos
      const now = this.clock.now();

      // 7. conferências com tudo travado
      if (season.status === "ipo_closed" && !(await ipoSettled(tx.db, season.id))) throw entryError("entry_not_ready");
      if (locked.some((c) => c.lastPrice === null && c.ipoPrice === null)) throw entryError("entry_not_ready");
      if (entryWindow(serieA, now.getTime()).state === "closed") throw entryError("entry_window_closed");
      if (owner.type === "user") {
        const [account] = await tx.db.select({ status: users.status }).from(users).where(eq(users.id, owner.userId));
        if (account?.status !== "active") throw entryError("account_blocked");
      }

      // 8. a carteira já existe? Depois da trava, duas chamadas ao mesmo tempo se enfileiram e a segunda enxerga a primeira
      const answer = await this.answerIfEntered(tx.db, owner, mode, season.id);
      if (answer) return answer;

      // 9. a conta, com a mesma função da prévia
      const quote = entryQuote(Object.fromEntries(locked.map((c) => [c.ticker, referencePrice(c)])));
      const lines = quote.n > 0 ? quote.clubs : [];

      // 10. as ações emitidas entram no total de cada clube (todos sobem o mesmo N)
      if (quote.n > 0) {
        await tx.db
          .update(seasonClubs)
          .set({ totalShares: sql`${seasonClubs.totalShares} + ${quote.n}` })
          .where(and(eq(seasonClubs.seasonId, season.id), inArray(seasonClubs.clubId, locked.map((c) => c.clubId))));
      }

      // 11. a carteira do novato, com os R$ 100.000,00 do `initial` (a carteira nova conta como travada)
      const wallet = await this.ledger.openWallet(tx, {
        seasonId: season.id,
        owner: owner.type === "user" ? { type: "user", userId: owner.userId } : { type: "bot", botId: owner.botId },
        at: now,
        entryMode: mode,
        initialCash: ENTRY_TOTAL,
      });
      const clubIdOf = new Map(locked.map((c) => [c.ticker, c.clubId]));
      const ref = { type: "entry", id: wallet.id };
      const indexMovements = (walletId: number, cash: boolean): Movement[] =>
        lines.map((l) => ({
          walletId,
          at: now,
          kind: "index_entry",
          clubId: clubIdOf.get(l.ticker)!,
          cashDelta: cash ? -l.shares * l.price : 0,
          sharesDelta: l.shares,
          price: l.price,
          costBasis: "purchase",
          ref,
        }));

      // 12. a emissão no extrato: na carteira do novato (índice) ou na tesouraria, por último (só caixa)
      let posted: PostManyResult = { results: [], entries: [], positions: new Map() };
      if (mode === "index") {
        posted = await this.ledger.postMany(tx, indexMovements(wallet.id, true));
      } else if (lines.length > 0) {
        await lockWallets(tx, [treasury!.id]);
        await this.ledger.postMany(tx, indexMovements(treasury!.id, false));
      }

      // 13. os avisos do dono, depois do COMMIT: preço e livro não mudam, então nada no canal público
      if (owner.type === "user") {
        this.events.entered(tx, owner.userId, {
          initialCash: wallet.cash,
          at: now,
          posted: posted.results.map((r: PostResult, i) => ({ result: r, ticker: lines[i]!.ticker })),
        });
      }

      // 14. o COMMIT é do `withTransaction`
      const result: EnterResult =
        mode === "index"
          ? {
              mode,
              n: quote.n,
              sum: quote.n > 0 ? quote.sum : 0,
              cash: quote.cash,
              stockValue: quote.stockValue,
              enteredAt: now.toISOString(),
              repeated: false,
              clubs: lines,
            }
          : { mode, n: 0, sum: 0, cash: ENTRY_TOTAL, stockValue: 0, enteredAt: now.toISOString(), repeated: false, clubs: [] };
      return { result, created: true, walletId: wallet.id };
    }, options.transaction);
  }

  /** Estados da temporada que recusam a entrada, na ordem do plano. `null` deixa passar. */
  private refuse(gate: ReturnType<typeof seasonGate>, reason: string | null): void {
    if (gate === "not_open_yet") throw entryError("entry_not_open");
    if (gate === "window_closed") throw entryError("entry_window_closed");
    if (gate === "market_suspended") throw entryError("market_suspended", reason ?? undefined);
  }

  /**
   * Se a pessoa já tem carteira na temporada: o mesmo modo devolve o resultado guardado (`repeated`), outro modo
   * `already_entered`; a carteira do IPO (sem entrada no meio) também é `already_entered`. Reconstrói o resultado do
   * extrato: as linhas `index_entry` da própria carteira (índice).
   */
  private async answerIfEntered(db: Db, owner: EntryOwner, mode: EntryModeChoice, knownSeasonId?: number): Promise<EnterOutcome | undefined> {
    const seasonId = knownSeasonId ?? (await currentSeason(db))?.id;
    if (seasonId === undefined) return undefined;
    const wallet = await findWallet(db, seasonId, owner);
    if (!wallet) return undefined;
    if (wallet.entryMode !== mode) throw entryError("already_entered");
    const lines =
      mode === "index"
        ? await db
            .select({ ticker: clubs.ticker, price: walletEntries.price, shares: walletEntries.sharesDelta })
            .from(walletEntries)
            .innerJoin(clubs, eq(clubs.id, walletEntries.clubId))
            .where(and(eq(walletEntries.walletId, wallet.id), eq(walletEntries.kind, "index_entry")))
        : [];
    const clubLines = lines
      .map((l) => ({ ticker: l.ticker!, price: l.price!, shares: l.shares }))
      .sort((a, b) => (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0));
    const n = clubLines[0]?.shares ?? 0;
    const sum = clubLines.reduce((acc, l) => acc + l.price, 0);
    const result: EnterResult = {
      mode,
      n,
      sum,
      cash: ENTRY_TOTAL - n * sum,
      stockValue: n * sum,
      enteredAt: wallet.enteredAt.toISOString(),
      repeated: true,
      clubs: clubLines,
    };
    return { result, created: false, walletId: wallet.id };
  }
}
