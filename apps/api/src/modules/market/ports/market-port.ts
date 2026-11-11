import { Injectable, Optional } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { Clock } from "../../../infra/clock/index.js";
import { type Database, type DrizzleTx, type LockedClub, lockClubs, type Tx } from "../../../infra/db/index.js";
import { wallets } from "../../../infra/db/schema/index.js";
import { currentSeason } from "../../admin/current-season.js";
import { MarketPort, type RefreshReason } from "../../admin/results/ports.js";
import { RefreshService } from "../maker/refresh.service.js";
import { instantOf } from "../matching/postgres-matching-engine.js";
import { CancelService } from "../orders/cancel.service.js";
import { MarketEvents } from "../realtime/events.js";
import { tradingGate } from "../state/gate.js";
import { isAuctionPaused, pauseAuction, restartAuction } from "../state/tunnel-state.js";

/**
 * A porta do mercado que a F7 chama (`MarketPort`, T13 e L7 do Plano do livro de ofertas e formador), no lugar da
 * porta vazia: a suspensão e a retomada (`SuspensionService`) e os placares importados ou corrigidos (que pedem a
 * reposição da casa). Roda sempre na transação de quem chama.
 *
 * **Suspensão** (`cancelHouseQuotes`, Livro de ofertas, critério 32; Admin, critérios 23 e 24): quem chama já travou o
 * clube (temporada compartilhada e clube) ou todos os clubes (temporada exclusiva e todos, no mercado todo) e já gravou
 * o motivo. Aqui saem do livro só as cotações da casa nesses clubes, canceladas com `suspension` e com a reserva devolvida
 * à tesouraria; as ordens dos jogadores e dos bots ficam no livro, e cancelá-las continua aceito. O leilão aberto para a
 * contagem (critério 45 e D5): fica só o início, sem fim marcado, e nada o fecha até a retomada. A recusa das ordens
 * novas é da porta do horário (`tradingGate`), que lê o motivo gravado.
 *
 * **Retomada** (`requestRefresh` com `resume`): quem chama já tirou o motivo e passa só os clubes que não têm suspensão
 * própria. O leilão parado recomeça com 3 horas contadas da retomada quando, com as colunas já gravadas, não sobra
 * suspensão do clube nem do mercado (D5: retomar o mercado com o clube ainda suspenso à parte, ou o clube com o mercado
 * ainda suspenso, não recomeça). Depois grava o pedido de reposição, e a casa cota de novo na mesma hora (o
 * `RefreshWaker` acorda a reposição depois do `COMMIT`). Os outros motivos só gravam o pedido, sem travar nada.
 */
@Injectable()
export class MarketPortImpl extends MarketPort {
  constructor(
    private readonly cancels: CancelService,
    private readonly refresh: RefreshService,
    private readonly clock: Clock,
    /** Os avisos depois do `COMMIT`: o clube marcado para republicar `book` e `price` quando o leilão para ou recomeça. */
    @Optional() private readonly events?: MarketEvents,
  ) {
    super();
  }

  async cancelHouseQuotes(tx: Tx, tickers: readonly string[]): Promise<void> {
    const unique = [...new Set(tickers)].sort();
    if (unique.length === 0) return;
    const season = await currentSeason(tx.db);
    if (!season) throw new Error("suspensão sem temporada atual");
    // Os clubes já estão travados por quem chama: aqui só se relê a linha (com o leilão) na mesma trava.
    const locked = await lockClubs(tx, season.id, unique);
    const at = latestInstant(this.clock.now(), locked);
    for (const club of locked) {
      if (await pauseAuction(tx, club, at)) this.events?.book.markClubDirty(tx, club.ticker);
    }
    // Antes da abertura das ofertas não há tesouraria, e a casa não tem cotação para tirar.
    const treasury = await treasuryOf(tx.db, season.id);
    if (treasury !== null) await this.cancels.cancelOrders(tx, treasury, { tickers: unique }, "suspension", at);
  }

  async requestRefresh(tx: Tx, tickers: readonly string[], reason: RefreshReason): Promise<void> {
    const unique = [...new Set(tickers)].sort();
    if (unique.length === 0) return;
    const season = await currentSeason(tx.db);
    if (!season) throw new Error("pedido de reposição sem temporada atual");
    if (reason === "resume") {
      // A temporada e os clubes lidos na transação da retomada, depois de o motivo sair: o que sobrou de suspensão.
      const locked = await lockClubs(tx, season.id, unique);
      const at = latestInstant(this.clock.now(), locked);
      for (const club of locked) {
        if (!isAuctionPaused(club) || !tradingGate(season, club, at).open) continue;
        await restartAuction(tx, club, at);
        this.events?.book.markClubDirty(tx, club.ticker);
      }
    }
    await this.refresh.requestRefresh(tx, unique, reason, { seasonId: season.id });
  }
}

/** O instante da suspensão ou da retomada: o relógio, nunca antes do último negócio dos clubes (como o da ordem). */
function latestInstant(now: Date, clubs: readonly LockedClub[]): Date {
  return clubs.reduce((at, club) => instantOf(at, club.lastTradeAt), now);
}

/** A carteira da tesouraria da temporada, ou nulo antes de ela existir. */
async function treasuryOf(db: Database | DrizzleTx, seasonId: number): Promise<number | null> {
  const [row] = await db
    .select({ id: wallets.id })
    .from(wallets)
    .where(and(eq(wallets.seasonId, seasonId), eq(wallets.ownerType, "treasury")));
  return row?.id ?? null;
}
