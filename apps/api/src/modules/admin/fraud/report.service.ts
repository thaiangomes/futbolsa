import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import {
  COMMON_ERROR_MESSAGES,
  FRAUD_ERROR_MESSAGES,
  fraudReportSchema,
  type CreateFraudCaseBody,
  type FraudCaseDetail,
  type FraudMonth,
  type FraudReport,
  type FraudSeriesPoint,
} from "@futbolsa/contracts";
import { monthKey, rank } from "@futbolsa/engine";
import { Clock } from "../../../infra/clock/index.js";
import { DB, type Database, type Tx, withTransaction } from "../../../infra/db/index.js";
import { clubs, fraudCases, fraudCaseTrades, seasons, users, wallets } from "../../../infra/db/schema/index.js";
import { DomainError } from "../../../infra/http/index.js";
import { auditTrades, displayedPrices, fairValuesAt, FairValueService, type AuditTradeRow } from "../../market/index.js";
import { baseOf, closeAtOfMonth } from "../../rankings/base.js";
import { participants } from "../../rankings/participants.js";
import { EquityAt } from "../../portfolio/valuation/equity-at.js";
import { currentSeason } from "../current-season.js";
import { AdminLogService } from "../log/index.js";
import { fraudParties } from "./parties.js";
import { monthsOf, reportTrades, seriesInstants, type PairTrade } from "./report.js";

export type CaseRow = typeof fraudCases.$inferSelect;

const notFound = () => new DomainError("case_not_found", 404, FRAUD_ERROR_MESSAGES.case_not_found);
/** Mais negócios que isto num par e período: o relatório recusa em vez de montar uma leitura enorme. */
const MAX_TRADES = 5000;

const toPair = (r: AuditTradeRow): PairTrade => ({
  id: r.id,
  at: r.at,
  clubId: r.clubId,
  ticker: r.ticker,
  quantity: r.quantity,
  price: r.price,
  priceBefore: r.priceBefore,
  inAuction: r.inAuction,
  withHouse: r.withHouse,
  annulled: r.annulled,
  buyerWalletId: r.buyerWalletId,
  sellerWalletId: r.sellerWalletId,
});

/**
 * O relatório de trapaça (T22): abre pelo alerta ou pela auditoria (`POST /admin/fraud/cases`) e, com o caso aberto, é
 * calculado **na hora**, numa transação só de leitura (a leitura é pesada e roda só quando o admin abre; nada é gravado).
 * Decidido, devolve a foto guardada na decisão, que não tem e-mail nem apelido (proposta 25). O valor justo da casa só sai
 * por aqui, a rota do admin. O "com e sem" usa o `ignoreTrades` do `EquityAt` e dos preços: a mesma conta da anulação para um
 * conjunto de negócios que ainda não foi anulado.
 */
@Injectable()
export class FraudReportService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly clock: Clock,
    private readonly fairValues: FairValueService,
    private readonly log: AdminLogService,
  ) {}

  /** `GET /admin/fraud/cases/:id`. */
  async detail(caseId: number, without?: readonly number[]): Promise<FraudCaseDetail> {
    const [row] = await this.db.select().from(fraudCases).where(eq(fraudCases.id, caseId));
    if (!row) throw notFound();
    const parties = await fraudParties(this.db, row.seasonId, [row.walletLow, row.walletHigh], row.status === "open" ? undefined : row.id);
    const report = row.status !== "open" && row.report ? fraudReportSchema.parse(row.report) : await withTransaction(this.db, (tx) => this.compute(tx, row, without));
    const [openedBy, decidedBy] = await Promise.all([this.nickname(row.openedBy), this.nickname(row.decidedBy)]);
    const [ticker] = row.clubId === null ? [] : await this.db.select({ t: clubs.ticker }).from(clubs).where(eq(clubs.id, row.clubId));
    return {
      id: row.id,
      origin: row.origin as FraudCaseDetail["origin"],
      status: row.status as FraudCaseDetail["status"],
      ticker: ticker?.t ?? null,
      periodFrom: row.periodFrom.toISOString(),
      periodTo: row.periodTo.toISOString(),
      openedAt: row.openedAt.toISOString(),
      openedBy,
      decidedAt: row.decidedAt?.toISOString() ?? null,
      decidedBy,
      decisionReason: row.decisionReason,
      parties: [parties.get(row.walletLow)!, parties.get(row.walletHigh)!],
      reportHash: row.reportHash,
      report,
    };
  }

  /** `POST /admin/fraud/cases`: o relatório manual de um par (usuário ou bot; a casa é recusada). */
  async open(adminId: string, body: CreateFraudCaseBody): Promise<FraudCaseDetail> {
    const caseId = await withTransaction(this.db, async (tx) => {
      const season = await currentSeason(tx.db);
      if (!season) throw new DomainError("no_season", 409, "Não há temporada em preparação ou em andamento.");
      const a = await this.walletOf(tx, season.id, body.accountA);
      const b = await this.walletOf(tx, season.id, body.accountB);
      if (a === b) throw new DomainError("fraud_same_account", 400, FRAUD_ERROR_MESSAGES.fraud_same_account);
      let clubId: number | null = null;
      if (body.ticker) {
        const [club] = await tx.db.select({ id: clubs.id }).from(clubs).where(eq(clubs.ticker, body.ticker));
        if (!club) throw new DomainError("invalid_input", 400, COMMON_ERROR_MESSAGES.invalid_input, ["ticker"]);
        clubId = club.id;
      }
      const [low, high] = a < b ? [a, b] : [b, a];
      const [created] = await tx.db
        .insert(fraudCases)
        .values({
          seasonId: season.id,
          origin: "manual",
          walletLow: low,
          walletHigh: high,
          clubId,
          periodFrom: new Date(body.from),
          periodTo: new Date(body.to),
          openedBy: adminId,
          openedAt: this.clock.now(),
        })
        .returning();
      const trades = await this.pairTrades(tx, created!);
      if (trades.length > 0) {
        const marked = reportTrades(trades);
        await tx.db.insert(fraudCaseTrades).values(marked.map((t) => ({ caseId: created!.id, tradeId: t.id, suspicious: t.suspicious })));
      }
      await this.log.record(tx, {
        actorId: adminId,
        action: "fraud.open",
        targetType: "fraud_case",
        targetId: String(created!.id),
        after: { origin: "manual", walletLow: low, walletHigh: high, ticker: body.ticker ?? null, from: body.from, to: body.to },
      });
      return created!.id;
    });
    return this.detail(caseId);
  }

  /**
   * Monta o relatório (sem escrever nada). `without` são os negócios a tirar do "com e sem"; sem eles, os suspeitos do par.
   * Chamado também pela decisão (T25), que o guarda como a foto do caso.
   */
  async compute(tx: Tx, c: CaseRow, without?: readonly number[], selected: ReadonlySet<number> = new Set()): Promise<FraudReport> {
    const now = this.clock.now();
    const pair = [c.walletLow, c.walletHigh] as const;
    const trades = await this.pairTrades(tx, c);
    const marked = reportTrades(trades, selected);
    const annulled = new Set(trades.filter((t) => t.annulled).map((t) => t.id));
    const chosen = without ?? marked.filter((t) => t.suspicious).map((t) => t.id);
    const ignore = new Set(chosen.filter((id) => !annulled.has(id)));
    const pairIds = new Set(trades.filter((t) => !t.annulled).map((t) => t.id));
    const from = c.periodFrom.getTime();
    const to = Math.min(c.periodTo.getTime(), now.getTime());
    const tickers = [...new Set(trades.map((t) => t.ticker))].sort();

    // peso no clube: quantos negócios do clube e como o preço andou com e sem os do par
    const atFrom = await displayedPrices(tx.db, c.seasonId, c.periodFrom);
    const atTo = await displayedPrices(tx.db, c.seasonId, new Date(to));
    const atToWithout = await displayedPrices(tx.db, c.seasonId, new Date(to), { ignoreTrades: pairIds });
    const clubsWeight: FraudReport["clubs"] = [];
    for (const ticker of tickers) {
      const all = await auditTrades(tx.db, { seasonId: c.seasonId, ticker, from: c.periodFrom, to: new Date(to + 1), limit: MAX_TRADES * 4 });
      clubsWeight.push({
        ticker,
        clubTrades: all.length,
        pairTrades: trades.filter((t) => t.ticker === ticker).length,
        priceFrom: atFrom.get(ticker) ?? 0,
        priceTo: atTo.get(ticker) ?? 0,
        priceToWithoutPair: atToWithout.get(ticker) ?? 0,
      });
    }

    const series = await this.series(tx, c.seasonId, from, to, tickers, ignore);
    const months = await this.months(tx, c, from, to, now, ignore);

    // os negócios das duas contas com outros jogadores, à parte
    const others: FraudReport["others"] = [];
    const seen = new Set<number>();
    for (const walletId of pair) {
      const rows = await auditTrades(tx.db, {
        seasonId: c.seasonId,
        wallet: walletId,
        ...(c.clubId !== null && tickers.length === 1 ? { ticker: tickers[0]! } : {}),
        from: c.periodFrom,
        to: new Date(c.periodTo.getTime() + 1),
        limit: MAX_TRADES,
      });
      for (const r of rows) {
        const other = r.buyerWalletId === walletId ? r.sellerWalletId : r.buyerWalletId;
        if (other === pair[0] || other === pair[1] || seen.has(r.id * 2 + (walletId === c.walletLow ? 0 : 1))) continue;
        seen.add(r.id * 2 + (walletId === c.walletLow ? 0 : 1));
        others.push({ id: r.id, at: r.at.toISOString(), ticker: r.ticker, quantity: r.quantity, price: r.price, walletId, side: r.buyerWalletId === walletId ? "buy" : "sell" });
      }
    }
    others.sort((x, y) => x.at.localeCompare(y.at) || x.id - y.id);

    return { trades: marked, clubs: clubsWeight, series, months, others };
  }

  /** Os negócios do par no período (e no clube, se o caso for de um clube só), do mais antigo para o mais novo. */
  private async pairTrades(tx: Tx, c: CaseRow): Promise<PairTrade[]> {
    let ticker: string | undefined;
    if (c.clubId !== null) {
      const [club] = await tx.db.select({ t: clubs.ticker }).from(clubs).where(eq(clubs.id, c.clubId));
      ticker = club?.t ?? undefined;
    }
    const rows = await auditTrades(tx.db, {
      seasonId: c.seasonId,
      pair: [c.walletLow, c.walletHigh],
      ...(ticker ? { ticker } : {}),
      from: c.periodFrom,
      to: new Date(c.periodTo.getTime() + 1),
      limit: MAX_TRADES + 1,
    });
    if (rows.length > MAX_TRADES) throw new DomainError("invalid_input", 400, "O período tem negócios demais: escolha um período menor.", ["to"]);
    return rows.map(toPair).sort((a, b) => a.at.getTime() - b.at.getTime() || a.id - b.id);
  }

  /** Um ponto por dia (no máximo 60) por clube: o preço com e sem os negócios e o valor justo da casa. */
  private async series(tx: Tx, seasonId: number, from: number, to: number, tickers: string[], ignore: ReadonlySet<number>): Promise<FraudSeriesPoint[]> {
    if (tickers.length === 0) return [];
    // sem valores da temporada (ou copa sem a tabela confirmada) não há valor justo; o resto do relatório vale
    let data: Awaited<ReturnType<FairValueService["load"]>> | null = null;
    try {
      data = await this.fairValues.load(seasonId, tx.db);
    } catch {
      data = null;
    }
    const out: FraudSeriesPoint[] = [];
    for (const instant of seriesInstants(from, to)) {
      const at = new Date(instant);
      const withTrades = await displayedPrices(tx.db, seasonId, at);
      const without = await displayedPrices(tx.db, seasonId, at, { ignoreTrades: ignore });
      let fair: Map<string, number> | null = null;
      try {
        fair = data ? fairValuesAt(data, instant) : null;
      } catch {
        fair = null;
      }
      for (const ticker of tickers) {
        out.push({ at: at.toISOString(), ticker, price: withTrades.get(ticker) ?? 0, priceWithout: without.get(ticker) ?? 0, fairValue: fair?.get(ticker) ?? null });
      }
    }
    return out;
  }

  /** Patrimônio e posição no ranking das duas contas no fechamento de cada mês do período (no mês aberto, agora). */
  private async months(tx: Tx, c: CaseRow, from: number, to: number, now: Date, ignore: ReadonlySet<number>): Promise<FraudMonth[]> {
    const [season] = await tx.db.select({ bots: seasons.botsInRankings }).from(seasons).where(eq(seasons.id, c.seasonId));
    const pair = [c.walletLow, c.walletHigh];
    const out: FraudMonth[] = [];
    for (const key of monthsOf(from, to, monthKey)) {
      const close = closeAtOfMonth(key);
      const open = close.getTime() > now.getTime();
      const at = open ? now : close;
      const people = await participants(tx, c.seasonId, at, { botsIncluded: season?.bots ?? false });
      const ids = [...new Set([...people.map((p) => p.walletId), ...pair])];
      const withTrades = await EquityAt.forSeason(tx, c.seasonId, at, { wallets: ids });
      const withoutTrades = await EquityAt.forSeason(tx, c.seasonId, at, { wallets: ids, ignoreTrades: ignore });
      const base = await baseOf(tx, c.seasonId, key, people);
      const positions = (equity: Map<number, { equity: number }>) =>
        new Map(
          rank(
            people
              .filter((p) => equity.has(p.walletId) && (base.get(p.walletId) ?? 0) > 0)
              .map((p) => ({ id: String(p.walletId), equity: equity.get(p.walletId)!.equity, base: base.get(p.walletId)! })),
          ).map((r) => [Number(r.id), r.position] as const),
        );
      const rankWith = positions(withTrades);
      const rankWithout = positions(withoutTrades);
      out.push({
        month: key,
        at: at.toISOString(),
        open,
        accounts: pair.map((walletId) => ({
          walletId,
          equity: withTrades.get(walletId)?.equity ?? 0,
          equityWithout: withoutTrades.get(walletId)?.equity ?? 0,
          rank: rankWith.get(walletId) ?? null,
          rankWithout: rankWithout.get(walletId) ?? null,
        })),
      });
    }
    return out;
  }

  /** A carteira da conta na temporada; a casa e a conta sem carteira são recusadas. */
  private async walletOf(tx: Tx, seasonId: number, account: CreateFraudCaseBody["accountA"]): Promise<number> {
    const where =
      "userId" in account ? and(eq(wallets.seasonId, seasonId), eq(wallets.userId, account.userId)) : and(eq(wallets.seasonId, seasonId), eq(wallets.botId, account.botId));
    const [w] = await tx.db.select({ id: wallets.id, ownerType: wallets.ownerType }).from(wallets).where(where);
    if (!w) throw new DomainError("no_wallet", 404, "A conta não tem carteira nesta temporada.");
    if (w.ownerType === "treasury") throw new DomainError("fraud_house_account", 400, FRAUD_ERROR_MESSAGES.fraud_house_account);
    return w.id;
  }

  private async nickname(userId: string | null): Promise<string | null> {
    if (!userId) return null;
    const [u] = await this.db.select({ n: users.nickname }).from(users).where(eq(users.id, userId));
    return u?.n ?? null;
  }
}
