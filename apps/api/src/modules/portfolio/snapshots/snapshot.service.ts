import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Snapshot } from "@futbolsa/contracts";
import { monthCloseAt, monthKey, portfolioSlices } from "@futbolsa/engine";
import { Clock } from "../../../infra/clock/index.js";
import { DB, type Database, withTransaction } from "../../../infra/db/index.js";
import { clubs, portfolioSnapshots, users, wallets } from "../../../infra/db/schema/index.js";
import type { Tx } from "../../../infra/db/transaction.js";
import { currentSeason } from "../../admin/current-season.js";
import { CLOSE_GRACE_MS } from "../daily/days.js";
import { EquityAt } from "../valuation/equity-at.js";

const CHUNK = 1000;

/**
 * A foto mensal da carteira (T10): as fatias em % de cada carteira de jogador no fechamento do mês (`monthCloseAt`,
 * 23:59 de Brasília do último dia), só décimos de ponto percentual por ticker e `cash`, sem quantidade, preço, valor ou
 * dividendo. Quem entra depois do fechamento do mês só ganha foto no fim do mês em que entrou (critério 32).
 */
@Injectable()
export class SnapshotService {
  private running = false;

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  /**
   * Grava as fotos de todas as carteiras de jogador que já tinham entrado em `at` e ainda não têm a do mês de `at`,
   * **dentro da transação de quem chama** (a F15 chama no encerramento, com as carteiras travadas). Gravar de novo não
   * muda uma foto já gravada. Devolve quantas gravou.
   */
  async takeSnapshots(tx: Tx, seasonId: number, at: Date): Promise<number> {
    const month = monthKey(at.getTime());
    const missing = await tx.db.execute(sql`
      select w.id from futbolsa.wallets w
      where w.season_id = ${seasonId} and w.owner_type = 'user' and w.entered_at <= ${at.toISOString()}::timestamptz
        and not exists (select 1 from futbolsa.portfolio_snapshots s where s.wallet_id = w.id and s.month = ${month})
      order by w.id`);
    const ids = missing.rows.map((r) => Number(r.id));
    let written = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const equities = await EquityAt.forSeason(tx, seasonId, at, { wallets: ids.slice(i, i + CHUNK) });
      const rows = [...equities.values()].map((e) => ({
        walletId: e.walletId,
        month,
        // a base é caixa + ações, sem o a receber (P5); com a recompra fechada as ações valem R$ 0,00
        slices: portfolioSlices({
          cash: e.cash,
          positions: e.positions.map((p) => ({ ticker: p.ticker, value: e.buybackClosed ? 0 : p.shares * p.price })),
        }),
        takenAt: at,
      }));
      if (rows.length === 0) continue;
      const inserted = await tx.db.insert(portfolioSnapshots).values(rows).onConflictDoNothing().returning({ walletId: portfolioSnapshots.walletId });
      written += inserted.length;
    }
    return written;
  }

  /** Uma passada da tarefa: grava o que falta dos meses já fechados (há mais de 30 segundos), do mais antigo para o mais novo. */
  async runOnce(now: Date = this.clock.now()): Promise<{ written: number; months: string[] }> {
    const report = { written: 0, months: [] as string[] };
    if (this.running) return report;
    this.running = true;
    try {
      const season = await currentSeason(this.db);
      if (!season || season.status === "closed" || season.status === "preparing") return report;
      const [first] = await this.db
        .select({ at: sql<Date>`min(${wallets.enteredAt})` })
        .from(wallets)
        .where(and(eq(wallets.seasonId, season.id), eq(wallets.ownerType, "user")));
      if (!first?.at) return report;
      const start = new Date(first.at).getTime();
      let year = Number(monthKey(start).slice(0, 4));
      let month = Number(monthKey(start).slice(5, 7));
      for (;;) {
        const closeAt = monthCloseAt(year, month);
        if (closeAt + CLOSE_GRACE_MS > now.getTime()) break;
        const written = await withTransaction(this.db, (tx) => this.takeSnapshots(tx, season.id, new Date(closeAt)), { isolationLevel: "repeatable read" });
        if (written > 0) {
          report.written += written;
          report.months.push(monthKey(closeAt));
        }
        month += 1;
        if (month > 12) {
          month = 1;
          year += 1;
        }
      }
      return report;
    } finally {
      this.running = false;
    }
  }

  /**
   * A foto mais nova do jogador **anterior ao mês de Brasília de agora**: no dia 1º o perfil já mostra o mês que
   * fechou, e no meio do mês continua o anterior (critérios 30 e 31). `null` sem foto ou sem conta.
   */
  async latestForNickname(nickname: string, now: Date = this.clock.now()): Promise<Snapshot | null> {
    const season = await currentSeason(this.db);
    if (!season) return null;
    const [row] = await this.db
      .select({ month: portfolioSnapshots.month, slices: portfolioSnapshots.slices })
      .from(portfolioSnapshots)
      .innerJoin(wallets, eq(wallets.id, portfolioSnapshots.walletId))
      .innerJoin(users, eq(users.id, wallets.userId))
      .where(
        and(
          eq(wallets.seasonId, season.id),
          sql`lower(${users.nickname}) = lower(${nickname})`,
          ne(users.status, "deleted"),
          sql`${portfolioSnapshots.month} < ${monthKey(now.getTime())}`,
        ),
      )
      .orderBy(sql`${portfolioSnapshots.month} desc`)
      .limit(1);
    if (!row) return null;
    const tickers = Object.keys(row.slices).filter((k) => k !== "cash");
    const names = tickers.length ? await this.db.select({ ticker: clubs.ticker, name: clubs.name }).from(clubs).where(inArray(clubs.ticker, tickers)) : [];
    const nameOf = new Map(names.map((n) => [n.ticker, n.name]));
    const slices = Object.entries(row.slices)
      .map(([key, permille]) => ({ key, name: key === "cash" ? null : (nameOf.get(key) ?? null), permille }))
      .sort((a, b) => (a.key === "cash" ? 1 : b.key === "cash" ? -1 : b.permille - a.permille || a.key.localeCompare(b.key)));
    return { month: row.month, slices };
  }
}
