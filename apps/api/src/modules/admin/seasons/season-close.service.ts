import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  ADMIN_ERROR_MESSAGES,
  COMMON_ERROR_MESSAGES,
  type CloseBlocker,
  type SeasonClosePreview,
  type SeasonCloseResponse,
} from "@futbolsa/contracts";
import { type CloseBlockerCode, type CloseState, closeBlockers } from "@futbolsa/engine";
import { Clock } from "../../../infra/clock/index.js";
import { DB, type Database, lockSeason, lockWallets, type Tx, withTransaction } from "../../../infra/db/index.js";
import { payoutEvents, seasons, wallets } from "../../../infra/db/schema/index.js";
import { DomainError } from "../../../infra/http/index.js";
import { SeasonResultsService } from "../../accounts/season-results.service.js";
import { MarketEvents } from "../../market/index.js";
import { PortfolioLedger, SnapshotService } from "../../portfolio/index.js";
import { EQUITY_BASE_CENTS } from "../../portfolio/valuation/constants.js";
import { CloseService, RecalcService } from "../../rankings/index.js";
import { buildRanking } from "../../rankings/build-ranking.js";
import { measure } from "../../rankings/close.js";
import { identities, participants } from "../../rankings/participants.js";
import { pendingRecalc } from "../../rankings/recalc.js";
import { AdminLogService } from "../log/index.js";
import { PayoutsStatusService } from "../payouts/outstanding.js";

type SeasonRow = typeof seasons.$inferSelect;

/** O texto e a tela do admin de cada pendência (a tela T9 mostra o texto e o link). */
const BLOCKER_TEXT: Record<CloseBlockerCode, (n: number) => string> = {
  buyback_not_closed: () => "A recompra ainda não fechou: a negociação acaba quando o jogo registra o fim do último evento da temporada.",
  matches_unscored: (n) => (n === 1 ? "1 jogo sem placar." : `${n} jogos sem placar.`),
  payouts_pending: (n) => (n === 1 ? "1 pagamento aguardando aprovação." : `${n} pagamentos aguardando aprovação.`),
  payouts_settling: (n) => (n === 1 ? "1 pagamento aprovado ainda sendo creditado." : `${n} pagamentos aprovados ainda sendo creditados.`),
  corrections_pending: (n) => (n === 1 ? "1 pagamento com correção a aplicar." : `${n} pagamentos com correção a aplicar.`),
  buyback_not_approved: (n) => (n === 1 ? "A recompra de 1 clube aguarda aprovação." : `A recompra de ${n} clubes aguarda aprovação.`),
  open_orders: (n) => (n === 1 ? "1 ordem aberta ou reserva." : `${n} ordens abertas ou reservas.`),
  shares_remaining: (n) => (n === 1 ? "1 carteira ainda tem ações." : `${n} carteiras ainda têm ações.`),
  // o fechamento do mês e cada pagamento pedem um recálculo, que a tarefa atende em até um minuto (F13)
  recalc_pending: () => "Há um recálculo de ranking em andamento. Espere um minuto e tente de novo.",
  fraud_open: (n) => (n === 1 ? "1 caso de trapaça aberto." : `${n} casos de trapaça abertos.`),
};

const BLOCKER_LINK: Record<CloseBlockerCode, string | null> = {
  buyback_not_closed: null,
  matches_unscored: "/admin/jogos",
  payouts_pending: "/admin/pagamentos",
  payouts_settling: "/admin/pagamentos",
  corrections_pending: "/admin/pagamentos/correcao",
  buyback_not_approved: "/admin/pagamentos",
  open_orders: null,
  shares_remaining: null,
  recalc_pending: null,
  fraud_open: "/admin/trapaca",
};

export function describeBlockers(list: ReturnType<typeof closeBlockers>): CloseBlocker[] {
  return list.map((b) => ({ code: b.code, count: b.count, text: BLOCKER_TEXT[b.code](b.count), link: BLOCKER_LINK[b.code] }));
}

const notFound = () => new DomainError("not_found", 404, COMMON_ERROR_MESSAGES.not_found);
const closedError = () => new DomainError("season_closed", 409, ADMIN_ERROR_MESSAGES.season_closed);

/**
 * O encerramento da temporada (Plano do encerramento e da recompra, T6; Admin, critérios 21, 22 e 38; Rankings 5, 19
 * e 20; Conta e login 15, 16 e 24). É o ponto sem volta da temporada: zera todas as carteiras e congela os rankings.
 *
 * - `preview` (`GET /admin/seasons/:id/close`): a lista do que falta (`closeBlockers` do motor, com o texto e a tela),
 *   e o que vai acontecer (carteiras, caixa total que some, o 1º do anual parcial pelo patrimônio de agora).
 * - `close` (`POST`), numa transação só: trava a temporada (exclusiva) e todas as carteiras dela em ordem de id, a
 *   tesouraria por último; confere a lista de novo com tudo travado e recusa com ela; C = relógio depois das travas;
 *   fecha os meses que a tarefa não fechou (`closeMonthsDue`), o mês de C e o anual (`closeSeason`, medidos em C pelo
 *   `EquityAt`, que conta as linhas `season_close` sempre como "depois"); grava `season_results`; a foto mensal em C;
 *   zera o caixa de cada carteira (linha `season_close`, inclusive o negativo); `closed` com `closed_at` = C; o registro
 *   do admin. Depois do `COMMIT`, `season.status` e o acordar dos rankings.
 *
 * Repetível: com a temporada já `closed`, `season_closed` sem mudar nada. Nenhuma conta recebe dinheiro (Conta 24).
 */
@Injectable()
export class SeasonCloseService {
  private readonly logger = new Logger("Encerramento");

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly clock: Clock,
    private readonly log: AdminLogService,
    private readonly payouts: PayoutsStatusService,
    private readonly rankings: CloseService,
    private readonly results: SeasonResultsService,
    private readonly snapshots: SnapshotService,
    private readonly ledger: PortfolioLedger,
    @Optional() private readonly recalc?: RecalcService,
    @Optional() private readonly events?: MarketEvents,
  ) {}

  async preview(seasonId: number): Promise<SeasonClosePreview> {
    const now = this.clock.now();
    return withTransaction(
      this.db,
      async (tx) => {
        const [season] = await tx.db.select().from(seasons).where(eq(seasons.id, seasonId));
        if (!season) throw notFound();
        const closed = season.status === "closed";
        const blockers = closed ? [] : describeBlockers(closeBlockers(await this.readState(tx, season, now)));
        const totals = await this.totals(tx, seasonId);
        return {
          seasonId,
          year: season.year,
          status: this.publicStatus(season.status),
          blockers,
          canClose: !closed && blockers.length === 0,
          summary: { wallets: totals.wallets, totalCash: totals.cash, leader: closed ? null : await this.leader(tx, season, now) },
        };
      },
      { isolationLevel: "repeatable read", readOnly: true },
    );
  }

  async close(actorId: string, seasonId: number, confirmYear: number): Promise<SeasonCloseResponse> {
    const result = await withTransaction(this.db, async (tx) => {
      const [exists] = await tx.db.select({ id: seasons.id }).from(seasons).where(eq(seasons.id, seasonId));
      if (!exists) throw notFound();
      // 1. a temporada exclusiva: nenhuma aprovação, correção, edição de jogo, ajuste ou outro encerramento anda junto
      const season = await lockSeason(tx, seasonId, "update");
      if (season.status === "closed") throw closedError();
      if (confirmYear !== season.year) throw new DomainError("confirm_year_mismatch", 400, ADMIN_ERROR_MESSAGES.confirm_year_mismatch);

      // 2. todas as carteiras da temporada, em ordem de id, a tesouraria por último
      const ids = (await tx.db.select({ id: wallets.id }).from(wallets).where(eq(wallets.seasonId, seasonId)).orderBy(asc(wallets.id))).map((w) => w.id);
      await lockWallets(tx, ids);

      // 3. a lista do que falta, de novo, com tudo travado (a tela pode ter lido antes de alguém mudar algo)
      const C = this.clock.now();
      const blockers = closeBlockers(await this.readState(tx, season, C));
      if (blockers.length > 0) {
        throw new DomainError("season_close_blocked", 409, ADMIN_ERROR_MESSAGES.season_close_blocked, undefined, { blockers: describeBlockers(blockers) });
      }
      const before = await this.totals(tx, seasonId);

      // 4. os rankings oficiais em C, antes de zerar: os meses que a tarefa não fechou, o mês de C e o anual
      const months = await this.rankings.closeMonthsDue(tx, seasonId, C);
      const closedRankings = await this.rankings.closeSeason(tx, { seasonId, at: C, now: C });

      // 5. o histórico de cada jogador, pelo anual recém-gravado
      const results = await this.results.record(tx, seasonId, C);

      // 6. a foto mensal em C (as carteiras ainda com o caixa)
      const photos = await this.snapshots.takeSnapshots(tx, seasonId, C);

      // 7. cada carteira a R$ 0,00 (ações e reservas já são zero, pela lista acima). Em lote (`postCashEach`, a mesma
      // conta e a mesma linha do `post`, em poucos comandos): com 10 mil carteiras, um `post` por carteira levava ~36 s
      // dos ~42 s da transação, com a temporada e todas as carteiras travadas (T10)
      const withCash = await tx.db
        .select({ id: wallets.id, cash: wallets.cash })
        .from(wallets)
        .where(and(eq(wallets.seasonId, seasonId), sql`${wallets.cash} <> 0`))
        .orderBy(asc(wallets.id));
      await this.ledger.postCashEach(
        tx,
        withCash.map((w) => ({ walletId: w.id, at: C, kind: "season_close" as const, cashDelta: -w.cash, ref: { type: "season", id: seasonId } })),
      );

      // 8. a temporada encerrada
      const [row] = await tx.db.update(seasons).set({ status: "closed", closedAt: C }).where(eq(seasons.id, seasonId)).returning();
      await this.log.record(tx, {
        actorId,
        action: "season.close",
        targetType: "season",
        targetId: String(seasonId),
        before: { status: season.status, wallets: before.wallets, totalCash: before.cash },
        after: {
          status: "closed",
          closedAt: C.toISOString(),
          walletsZeroed: withCash.length,
          results,
          photos,
          monthsClosed: months,
          closingMonthClosed: closedRankings.month,
          annualClosed: closedRankings.season,
        },
      });

      // 9. depois do COMMIT: o novo estado da temporada e os rankings
      this.events?.seasonStatus(tx, row!);
      tx.afterCommit(async () => {
        this.recalc?.wake();
      });
      return { seasonId, closedAt: C.toISOString(), wallets: ids.length, results };
    });
    this.logger.log(`temporada ${seasonId} encerrada em ${result.closedAt} (${result.wallets} carteiras, ${result.results} históricos)`);
    return result;
  }

  /** As contagens que o `closeBlockers` do motor recebe, lidas no `tx` de quem chama. */
  private async readState(tx: Tx, season: SeasonRow, now: Date): Promise<CloseState> {
    const seasonId = season.id;
    const outstanding = await this.payouts.outstanding(seasonId, now, tx);
    const [buyback] = await tx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(payoutEvents)
      .where(and(eq(payoutEvents.seasonId, seasonId), eq(payoutEvents.kind, "buyback"), eq(payoutEvents.status, "pending")));
    const buybackPending = buyback?.n ?? 0;
    const counts = await tx.db.execute(sql`
      select
        (select count(*)::int from futbolsa.matches m where m.season_id = ${seasonId}
           and (m.status in ('scheduled', 'postponed')
                or (m.status = 'finished' and (m.home_goals is null or m.away_goals is null)))) as matches,
        (select count(*)::int from futbolsa.orders o where o.season_id = ${seasonId} and o.status = 'open') as orders,
        (select count(*)::int from futbolsa.wallets w where w.season_id = ${seasonId}
           and (w.reserved_cash <> 0 or exists (
             select 1 from futbolsa.positions p where p.wallet_id = w.id and p.reserved_shares > 0))) as reserved,
        (select count(*)::int from futbolsa.wallets w where w.season_id = ${seasonId}
           and exists (select 1 from futbolsa.positions p where p.wallet_id = w.id and p.shares > 0)) as with_shares,
        (select count(*)::int from futbolsa.fraud_cases f where f.season_id = ${seasonId} and f.status = 'open') as fraud`);
    const c = counts.rows[0]!;
    const orders = Number(c.orders);
    return {
      tradingEnded: season.status === "trading_ended",
      matchesUnscored: Number(c.matches),
      payoutsPending: Math.max(0, outstanding.pending - buybackPending),
      payoutsSettling: outstanding.settling,
      correctionEvents: outstanding.correctionEvents,
      buybackPending,
      openOrders: orders > 0 ? orders : Number(c.reserved),
      walletsWithShares: Number(c.with_shares),
      recalcPending: await pendingRecalc(tx, seasonId),
      fraudOpen: Number(c.fraud),
    };
  }

  private async totals(tx: Tx, seasonId: number): Promise<{ wallets: number; cash: number }> {
    const [row] = await tx.db
      .select({ n: sql<number>`count(*)::int`, cash: sql<string>`coalesce(sum(${wallets.cash}), 0)::bigint` })
      .from(wallets)
      .where(eq(wallets.seasonId, seasonId));
    return { wallets: row?.n ?? 0, cash: Number(row?.cash ?? 0) };
  }

  /** O 1º do anual parcial, pelo patrimônio de agora (o mesmo cálculo da parcial ao vivo). */
  private async leader(tx: Tx, season: SeasonRow, now: Date): Promise<SeasonClosePreview["summary"]["leader"]> {
    const people = await participants(tx, season.id, now, { botsIncluded: season.botsInRankings });
    if (people.length === 0) return null;
    const measured = await measure(tx, season.id, now, people, async (list) => new Map(list.map((p) => [p.walletId, EQUITY_BASE_CENTS])));
    const [first] = buildRanking(measured);
    if (!first) return null;
    const who = (await identities(tx, [first.walletId])).get(first.walletId);
    return { nickname: who?.displayName ?? who?.botLabel ?? "conta excluída", equity: first.equity };
  }

  private publicStatus(status: string): SeasonClosePreview["status"] {
    if (status === "trading" || status === "trading_ended" || status === "closed") return status;
    return "preparing";
  }
}
