import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import type { DeleteBidResponse, IpoCash, PutBidBody, PutBidResponse } from "@futbolsa/contracts";
import { validateBid } from "@futbolsa/engine";
import { Clock } from "../../infra/clock/index.js";
import { DB, type Database, lockSeason, lockWallets, type SeasonRow, type Tx, type WalletRow, withTransaction } from "../../infra/db/index.js";
import { bots, clubs, ipoBids, seasonClubs, users, wallets } from "../../infra/db/schema/index.js";
import { currentSeason } from "../admin/current-season.js";
import { PortfolioLedger } from "../portfolio/index.js";
import { ipoError } from "./errors.js";

type BidRow = typeof ipoBids.$inferSelect;

/** O clube listado na temporada, com a faixa gravada na abertura. */
interface ListedBand {
  clubId: number;
  floor: number;
  ceiling: number;
}

/** O que a oferta pede: a quantidade e o preço máximo em centavos, e se cria (`new`) ou edita (`existing`). */
export type PlaceBidInput = PutBidBody;

/**
 * Ofertas do IPO (IPO por bookbuilding, critérios 8 a 14): registrar, editar e cancelar uma oferta
 * por clube, com a reserva de quantidade × min(preço máximo, teto) presa no caixa e a soma das reservas
 * limitada ao caixa. A mesma entrada para jogadores e bots: `place` e `cancel` recebem a carteira (o
 * controlador acha a do usuário; os bots da F14 chamam direto).
 *
 * Cada chamada é uma transação com a temporada travada em modo compartilhado (o fechamento, exclusivo,
 * espera as ofertas em andamento) e depois a carteira. A oferta só lê `season_clubs`: não trava clube,
 * porque a faixa não muda depois da abertura e duas ofertas no mesmo clube não disputam nada até a
 * liquidação. A carteira travada serializa as ofertas da mesma pessoa: a soma das reservas nunca passa
 * do caixa e duas abas não criam duas ofertas no mesmo clube.
 */
@Injectable()
export class IpoBidsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly ledger: PortfolioLedger,
    private readonly clock: Clock,
  ) {}

  /**
   * A carteira do usuário na temporada atual, para o controlador. Sem carteira: antes da abertura é
   * `ipo_not_open` (a carteira nasce na abertura); com o IPO aberto ou depois é `no_wallet` (conta que
   * chegou depois do fechamento entra pela Entrada no meio da temporada).
   */
  async walletOf(userId: string): Promise<number> {
    const season = await currentSeason(this.db);
    if (!season) throw ipoError("ipo_not_open");
    const [wallet] = await this.db
      .select({ id: wallets.id })
      .from(wallets)
      .where(and(eq(wallets.seasonId, season.id), eq(wallets.userId, userId)));
    if (wallet) return wallet.id;
    throw ipoError(season.status === "preparing" ? "ipo_not_open" : "no_wallet");
  }

  /**
   * Registra (`expect: "new"`) ou edita (`expect: "existing"`) a oferta da carteira no clube. A reserva
   * muda pela diferença (a reserva atual da mesma oferta conta como livre, critério 13), com a linha
   * `ipo_reserve` no extrato. Editar sem mudar nada não grava: não é alteração para o desempate.
   */
  place(walletId: number, ticker: string, input: PlaceBidInput): Promise<PutBidResponse> {
    return withTransaction(this.db, async (tx) => {
      const { season, band, now } = await this.openPeriod(tx, walletId, ticker);
      const [wallet] = await lockWallets(tx, [walletId]);
      await this.assertCanBid(tx, wallet!);

      const current = await this.bidOf(tx, season.id, band.clubId, walletId);
      const active = current?.status === "active" ? current : undefined;
      if (input.expect === "new" && active) throw ipoError("bid_exists");
      if (input.expect === "existing" && !active) throw ipoError("bid_not_found");
      if (active && active.quantity === input.quantity && active.maxPrice === input.maxPrice) {
        return { ticker, bid: bidView(active), cash: cashView(wallet!) };
      }

      const check = validateBid({
        quantity: input.quantity,
        maxPrice: input.maxPrice,
        band,
        freeCash: wallet!.cash - wallet!.reservedCash,
        currentReserve: active?.reserved ?? 0,
      });
      if (!check.ok) throw ipoError(check.code);

      const values = { quantity: input.quantity, maxPrice: input.maxPrice, reserved: check.reserve, status: "active", updatedAt: now };
      // A linha é única por temporada, clube e carteira: uma oferta cancelada volta a ser ativa nela.
      const [bid] = current
        ? await tx.db.update(ipoBids).set(values).where(eq(ipoBids.id, current.id)).returning()
        : await tx.db
            .insert(ipoBids)
            .values({ seasonId: season.id, clubId: band.clubId, walletId, createdAt: now, ...values })
            .returning();

      let after = wallet!;
      // Só o preço acima do teto mudou: a oferta muda (e o desempate), a reserva não.
      if (check.delta !== 0) {
        ({ wallet: after } = await this.ledger.post(tx, {
          walletId,
          at: now,
          kind: "ipo_reserve",
          reservedCashDelta: check.delta,
          ref: { type: "ipo_bid", id: bid!.id },
        }));
      }
      // O `wallet.changed` e o `entry.added` (tempo real) entram aqui com `tx.afterCommit`, na A10.
      return { ticker, bid: bidView(bid!), cash: cashView(after) };
    });
  }

  /** Cancela a oferta da carteira no clube e devolve a reserva ao caixa livre (critério 13). */
  cancel(walletId: number, ticker: string): Promise<DeleteBidResponse> {
    return withTransaction(this.db, async (tx) => {
      const { season, band, now } = await this.openPeriod(tx, walletId, ticker);
      const [wallet] = await lockWallets(tx, [walletId]);
      const current = await this.bidOf(tx, season.id, band.clubId, walletId);
      if (current?.status !== "active") throw ipoError("bid_not_found");
      const after = (await this.release(tx, current, now)) ?? wallet!;
      return { ticker, cash: cashView(after) };
    });
  }

  /**
   * Cancela as ofertas ativas da carteira (de um clube só, com `clubId`) dentro de uma transação que já
   * travou a temporada e a carteira, sem conferir o período nem lançar quando não há oferta. Para o
   * gancho de encerramento da conta (A6), que decide antes se o IPO está aberto. Devolve quantas cancelou.
   */
  async cancelLocked(tx: Tx, o: { walletId: number; at: Date; clubId?: number }): Promise<number> {
    if (!tx.locks.isWalletLocked(o.walletId)) throw new Error(`carteira ${o.walletId} não está travada nesta transação`);
    const open = await tx.db
      .select()
      .from(ipoBids)
      .where(
        and(
          eq(ipoBids.walletId, o.walletId),
          eq(ipoBids.status, "active"),
          o.clubId === undefined ? undefined : eq(ipoBids.clubId, o.clubId),
        ),
      )
      .orderBy(asc(ipoBids.id));
    for (const bid of open) await this.release(tx, bid, o.at);
    return open.length;
  }

  /** `cancelled`, reserva zero e a linha `ipo_reserve` devolvendo a reserva. Devolve a carteira depois. */
  private async release(tx: Tx, bid: BidRow, at: Date): Promise<WalletRow | undefined> {
    await tx.db.update(ipoBids).set({ status: "cancelled", reserved: 0, updatedAt: at }).where(eq(ipoBids.id, bid.id));
    if (bid.reserved === 0) return undefined;
    const { wallet } = await this.ledger.post(tx, {
      walletId: bid.walletId,
      at,
      kind: "ipo_reserve",
      reservedCashDelta: -bid.reserved,
      ref: { type: "ipo_bid", id: bid.id },
    });
    return wallet;
  }

  /**
   * Trava a temporada da carteira em modo compartilhado e confere o período e o clube. O relógio é lido
   * **depois** da trava: com o horário de fechamento passado, a oferta é recusada mesmo que a tarefa de
   * fechar ainda não tenha rodado (critério 14), e uma oferta que esperou o fechamento terminar vê o
   * status novo.
   */
  private async openPeriod(tx: Tx, walletId: number, ticker: string): Promise<{ season: SeasonRow; band: ListedBand; now: Date }> {
    const [owner] = await tx.db.select({ seasonId: wallets.seasonId }).from(wallets).where(eq(wallets.id, walletId));
    if (!owner) throw new Error(`carteira inexistente: ${walletId}`);
    const season = await lockSeason(tx, owner.seasonId, "share");
    const now = this.clock.now();
    if (season.status === "preparing") throw ipoError("ipo_not_open");
    if (season.status !== "ipo_open" || !season.ipoClosesAt || now.getTime() >= season.ipoClosesAt.getTime()) {
      throw ipoError("ipo_closed");
    }

    const [club] = await tx.db
      .select({ clubId: seasonClubs.clubId, floor: seasonClubs.bandFloor, ceiling: seasonClubs.bandCeiling })
      .from(seasonClubs)
      .innerJoin(clubs, eq(clubs.id, seasonClubs.clubId))
      .where(and(eq(seasonClubs.seasonId, season.id), eq(clubs.ticker, ticker)));
    if (!club) throw ipoError("club_not_listed");
    // A abertura grava a faixa de todo clube listado antes de passar para `ipo_open`.
    if (club.floor === null || club.ceiling === null) throw new Error(`clube ${ticker} sem faixa gravada com o IPO aberto`);
    return { season, band: { clubId: club.clubId, floor: club.floor, ceiling: club.ceiling }, now };
  }

  /**
   * Quem pode ofertar, conferido com a carteira travada: conta de jogador ativa (o bloqueado continua
   * dono do que tem, mas não oferta), bot ligado, e caixa não negativo (depois de um estorno, só volta a
   * ofertar quando o caixa sair do negativo). A tesouraria nunca oferta.
   */
  private async assertCanBid(tx: Tx, wallet: WalletRow): Promise<void> {
    if (wallet.ownerType === "treasury") throw new Error("a tesouraria não faz oferta no IPO");
    if (wallet.ownerType === "user") {
      const [user] = await tx.db.select({ status: users.status }).from(users).where(eq(users.id, wallet.userId!));
      if (user?.status !== "active") throw ipoError("account_blocked");
    } else {
      const [bot] = await tx.db.select({ active: bots.active }).from(bots).where(eq(bots.id, wallet.botId!));
      if (!bot?.active) throw ipoError("account_blocked");
    }
    if (wallet.cash < 0) throw ipoError("negative_cash");
  }

  private async bidOf(tx: Tx, seasonId: number, clubId: number, walletId: number): Promise<BidRow | undefined> {
    const [bid] = await tx.db
      .select()
      .from(ipoBids)
      .where(and(eq(ipoBids.seasonId, seasonId), eq(ipoBids.clubId, clubId), eq(ipoBids.walletId, walletId)));
    return bid;
  }
}

function bidView(bid: BidRow): PutBidResponse["bid"] {
  return { quantity: bid.quantity, maxPrice: bid.maxPrice, reserved: bid.reserved, updatedAt: bid.updatedAt.toISOString() };
}

function cashView(wallet: WalletRow): IpoCash {
  return { total: wallet.cash, reserved: wallet.reservedCash, free: wallet.cash - wallet.reservedCash };
}
