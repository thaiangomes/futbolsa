import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, eq, inArray, isNotNull, notExists, sql } from "drizzle-orm";
import { settleIpoClub } from "@futbolsa/engine";
import { DB, type Database, lockClubs, lockSeason, lockWallets, type Tx, withTransaction } from "../../infra/db/index.js";
import { clubs, ipoAllocations, ipoBids, ipoResults, seasonClubs, wallets } from "../../infra/db/schema/index.js";
import { currentSeason } from "../admin/current-season.js";
import { PortfolioLedger } from "../portfolio/index.js";
import { IpoEvents } from "./events.js";

/** Um clube que não liquidou nesta passada, com o erro (a passada seguinte tenta de novo). */
export interface IpoSettleFailure {
  ticker: string;
  error: Error;
}

/** O que uma passada da liquidação fez. */
export type IpoSettleResult =
  /** Nada a fazer: sem temporada ou fora de `ipo_closed` (antes do fechamento ou já negociando). */
  | { status: "idle" }
  /**
   * Passou pelos clubes em ordem de ticker: `settled` liquidou agora, `skipped` já estava liquidado
   * (por uma passada anterior ou por outra ao mesmo tempo), `failed` deu erro e fica para a próxima.
   * `pending` é quantos clubes listados ainda estão sem resultado no fim da passada: 0 é o IPO liquidado.
   */
  | { status: "ran"; seasonId: number; settled: string[]; skipped: string[]; failed: IpoSettleFailure[]; pending: number };

type ClubOutcome = "settled" | "skipped" | "stopped";

/**
 * Liquidação do IPO (IPO por bookbuilding, critérios 16 a 24 e 29; Carteira e gráficos, critério 1).
 *
 * Roda com a temporada em `ipo_closed`, **um clube por transação**, em ordem de ticker. Cada
 * transação trava, na ordem de todo o jogo, a temporada em modo compartilhado, o clube, as carteiras
 * das ofertas e a tesouraria por último; o clube travado serializa duas passadas ao mesmo tempo, e
 * quem chega depois vê o `ipo_results` gravado e pula. Liquidar é repetível: o clube com resultado
 * nunca é liquidado de novo, e um erro num clube desfaz só a transação dele (os outros seguem).
 *
 * Em cada clube, o motor (`settleIpoClub`) dá o preço de corte, o rateio, o que cada oferta paga e
 * recebe de volta, a sobra da oferta e o lote do formador; aqui só se grava:
 * - por oferta (atendida ou não), uma linha `ipo_settle` que solta a reserva inteira, tira o pago do
 *   caixa e põe as ações com o custo pelo preço de corte; a linha de `ipo_allocations`; e a oferta
 *   `settled`. A oferta guarda a reserva que tinha (`reserved` = pago + devolvido): é o `status` que
 *   diz que ela não prende mais caixa, e o `updated_at` do desempate fica como o jogador deixou;
 * - na tesouraria, até três linhas `ipo_settle`: o dinheiro pago por todos, a sobra da oferta e o lote
 *   do formador, as ações pelo preço de corte e sem pagamento (proposta 3); só as maiores que zero;
 * - o `ipo_results` do clube e, em `season_clubs`, o preço do IPO, as ações do clube (oferta + lote) e
 *   o preço exibido igual ao corte, ainda sem negócio (proposta 4).
 *
 * A temporada continua em `ipo_closed`: "liquidado" é ter o resultado de todos os clubes listados, e
 * quem abre a negociação é a F9. A oferta de conta excluída ou bloqueada depois do fechamento entra no
 * rateio como estava (proposta 8); as ações da excluída vão para a tesouraria pelo `account-closeout`
 * da F5, que espera o resultado de todos os clubes.
 */
@Injectable()
export class IpoSettlementService {
  private readonly logger = new Logger("IPO");
  private lastFailures: Array<{ ticker: string; error: string }> = [];

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly ledger: PortfolioLedger,
    private readonly events: IpoEvents,
  ) {}

  /**
   * Uma passada da tarefa (A7, a cada minuto, com o relógio da API): liquida os clubes ainda sem
   * resultado. Um erro num clube é registrado no log e devolvido em `failed`, e a passada segue para os
   * próximos; a seguinte tenta de novo o que faltou.
   */
  async settleDue(now: Date): Promise<IpoSettleResult> {
    const season = await currentSeason(this.db);
    if (!season || season.status !== "ipo_closed") {
      this.lastFailures = [];
      return { status: "idle" };
    }

    const listed = await this.listedClubs(season.id);
    const settled: string[] = [];
    // O que já tinha resultado no começo da passada nem abre transação (a tarefa roda a cada minuto até
    // a negociação abrir); o resto é conferido de novo com o clube travado.
    const skipped = listed.filter((c) => c.settled).map((c) => c.ticker);
    const failed: IpoSettleFailure[] = [];
    for (const { ticker } of listed.filter((c) => !c.settled)) {
      let outcome: ClubOutcome;
      try {
        outcome = await withTransaction(this.db, (tx) => this.settleClub(tx, season.id, ticker, now));
      } catch (caught) {
        const error = caught instanceof Error ? caught : new Error(String(caught));
        this.logger.error(`a liquidação do IPO de ${ticker} falhou e fica para a próxima passada: ${error.message}`, error.stack);
        failed.push({ ticker, error });
        continue;
      }
      // A temporada saiu de `ipo_closed` no meio da passada: não há mais o que liquidar.
      if (outcome === "stopped") break;
      (outcome === "settled" ? settled : skipped).push(ticker);
    }
    skipped.sort();
    // Guarda os erros da última passada para a visão geral do admin mostrar (decisão do Thaian em 2026-11-09):
    // um clube que liquidou sai da lista, e a lista toda some quando a passada seguinte não falha.
    this.lastFailures = failed.map((f) => ({ ticker: f.ticker, error: f.error.message }));
    return { status: "ran", seasonId: season.id, settled, skipped, failed, pending: await this.pendingClubs(season.id) };
  }

  /**
   * Os clubes que falharam na última passada desta instância, com a mensagem de erro, para a visão geral do
   * admin ("a liquidação do IPO de X está com erro"). Vazia enquanto nada falhou ou depois que a passada
   * seguinte liquida tudo; some também quando a temporada sai de `ipo_closed`.
   */
  failures(): ReadonlyArray<{ ticker: string; error: string }> {
    return this.lastFailures;
  }

  /** Quantos clubes listados na temporada ainda estão sem `ipo_results` (0 = o IPO está liquidado). */
  async pendingClubs(seasonId: number): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(seasonClubs)
      .where(
        and(
          eq(seasonClubs.seasonId, seasonId),
          notExists(
            this.db
              .select({ one: sql`1` })
              .from(ipoResults)
              .where(and(eq(ipoResults.seasonId, seasonClubs.seasonId), eq(ipoResults.clubId, seasonClubs.clubId))),
          ),
        ),
      );
    return row!.n;
  }

  /**
   * Os clubes listados em ordem de ticker (a mesma ordem binária do `lockClubs`), e se já têm resultado.
   * A F7 não lista clube sem ticker; se houvesse um, ele ficaria contado em `pending`.
   */
  private async listedClubs(seasonId: number): Promise<Array<{ ticker: string; settled: boolean }>> {
    const rows = await this.db
      .select({ ticker: clubs.ticker, resultClub: ipoResults.clubId })
      .from(seasonClubs)
      .innerJoin(clubs, eq(clubs.id, seasonClubs.clubId))
      .leftJoin(ipoResults, and(eq(ipoResults.seasonId, seasonClubs.seasonId), eq(ipoResults.clubId, seasonClubs.clubId)))
      .where(and(eq(seasonClubs.seasonId, seasonId), isNotNull(clubs.ticker)));
    return rows
      .map((r) => ({ ticker: r.ticker!, settled: r.resultClub !== null }))
      .sort((a, b) => (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0));
  }

  /** Liquida um clube numa transação. `stopped` quando a temporada já não está em `ipo_closed`. */
  private async settleClub(tx: Tx, seasonId: number, ticker: string, now: Date): Promise<ClubOutcome> {
    // O estado lido depois da trava é o que vale.
    const season = await lockSeason(tx, seasonId, "share");
    if (season.status !== "ipo_closed") return "stopped";
    const [club] = await lockClubs(tx, seasonId, [ticker]);
    const clubId = club!.clubId;
    // Outra passada pode ter liquidado o clube enquanto esperávamos a trava dele.
    const [done] = await tx.db
      .select({ clubId: ipoResults.clubId })
      .from(ipoResults)
      .where(and(eq(ipoResults.seasonId, seasonId), eq(ipoResults.clubId, clubId)));
    if (done) return "skipped";

    // A abertura (A2) só passa para `ipo_open` com a oferta e a faixa de todo clube gravadas.
    if (season.offerSize === null) throw new Error(`temporada ${seasonId} sem oferta gravada no ipo_closed`);
    if (club!.bandFloor === null || club!.bandCeiling === null) throw new Error(`clube ${ticker} sem faixa gravada no ipo_closed`);

    // Depois do fechamento nenhuma oferta muda (o fechamento esperou as que estavam em andamento, e o
    // gancho de encerramento não cancela no `ipo_closed`), então as ativas são as do rateio.
    const bids = await tx.db
      .select()
      .from(ipoBids)
      .where(and(eq(ipoBids.seasonId, seasonId), eq(ipoBids.clubId, clubId), eq(ipoBids.status, "active")))
      .orderBy(asc(ipoBids.id));
    const result = settleIpoClub({
      offer: season.offerSize,
      band: { floor: club!.bandFloor, ceiling: club!.bandCeiling },
      lotBp: season.mmLotBp,
      // O desempate do rateio é a última alteração da oferta (critério 17), em milissegundos.
      bids: bids.map((b) => ({
        id: b.id,
        walletId: b.walletId,
        quantity: b.quantity,
        maxPrice: b.maxPrice,
        reserved: b.reserved,
        updatedAt: b.updatedAt.getTime(),
      })),
    });

    const [treasury] = await tx.db
      .select({ id: wallets.id })
      .from(wallets)
      .where(and(eq(wallets.seasonId, seasonId), eq(wallets.ownerType, "treasury")));
    if (!treasury) throw new Error(`temporada ${seasonId} sem tesouraria (a abertura do IPO abre a carteira dela)`);
    // As carteiras das ofertas em ordem de id e a tesouraria por último (a própria função ordena).
    await lockWallets(tx, [...bids.map((b) => b.walletId), treasury.id]);

    const reservedOf = new Map(bids.map((b) => [b.id, b.reserved]));
    for (const a of result.allocations) {
      const posted = await this.ledger.post(tx, {
        walletId: a.walletId,
        at: now,
        kind: "ipo_settle",
        clubId,
        // A reserva sai inteira; o caixa perde só o pago. Como o pago nunca passa da reserva e a reserva
        // está dentro do caixa, o caixa não fica negativo nem abaixo do que continua reservado.
        reservedCashDelta: -reservedOf.get(a.bidId)!,
        ref: { type: "ipo_bid", id: a.bidId },
        // Atendida: as ações entram com o custo pelo preço de corte (Carteira e gráficos, critério 1).
        // Não atendida: a linha só devolve a reserva.
        ...(a.shares > 0 ? { cashDelta: -a.paid, sharesDelta: a.shares, price: result.cutPrice, costBasis: "purchase" as const } : {}),
      });
      // O dono vê o caixa, as ações do clube e a linha do extrato mudarem sem recarregar (depois do COMMIT).
      await this.events.posted(tx, posted, ticker);
    }
    if (result.allocations.length > 0) {
      await tx.db
        .insert(ipoAllocations)
        .values(result.allocations.map((a) => ({ bidId: a.bidId, shares: a.shares, paid: a.paid, refunded: a.refunded })));
      await tx.db
        .update(ipoBids)
        .set({ status: "settled" })
        .where(inArray(ipoBids.id, result.allocations.map((a) => a.bidId)));
    }

    // A tesouraria: o dinheiro de todos, a sobra da oferta e o lote do formador, este sem pagamento.
    const house = { walletId: treasury.id, at: now, kind: "ipo_settle", clubId, ref: { type: "ipo_result", id: clubId } } as const;
    if (result.treasuryCash > 0) await this.ledger.post(tx, { ...house, cashDelta: result.treasuryCash });
    for (const shares of [result.leftoverShares, result.lotShares]) {
      if (shares > 0) await this.ledger.post(tx, { ...house, sharesDelta: shares, price: result.cutPrice, costBasis: "purchase" });
    }

    await tx.db.insert(ipoResults).values({
      seasonId,
      clubId,
      cutPrice: result.cutPrice,
      demandAtCut: result.demandAtCut,
      allocationNum: result.ratio.num,
      allocationDen: result.ratio.den,
      treasuryShares: result.leftoverShares,
      mmLotShares: result.lotShares,
      settledAt: now,
    });
    await tx.db
      .update(seasonClubs)
      .set({ ipoPrice: result.cutPrice, totalShares: result.totalShares, lastPrice: result.cutPrice, lastTradeAt: null })
      .where(and(eq(seasonClubs.seasonId, seasonId), eq(seasonClubs.clubId, clubId)));
    // O `wallet.changed` e o `entry.added` (tempo real) entram aqui com `tx.afterCommit`, na A10.
    return "settled";
  }
}
