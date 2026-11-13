import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { ADMIN_ERROR_MESSAGES, type BlockResponse } from "@futbolsa/contracts";
import { Clock } from "../../../infra/clock/index.js";
import { DB, type Database, lockClubs, lockSeason, lockWallets, type Tx, withTransaction } from "../../../infra/db/index.js";
import { ipoBids, orders, users, wallets } from "../../../infra/db/schema/index.js";
import { DomainError } from "../../../infra/http/index.js";
import { AccountClosureHooks } from "../../accounts/closure-hooks.js";
import { accountError } from "../../accounts/errors.js";
import { lockAdminsAndCountOthers } from "../../accounts/roles.service.js";
import { currentSeason } from "../current-season.js";
import { AdminLogService } from "../log/index.js";

const notFound = () => new DomainError("player_not_found", 404, ADMIN_ERROR_MESSAGES.player_not_found);
const self = () => new DomainError("cannot_target_self", 409, ADMIN_ERROR_MESSAGES.cannot_target_self);

type UserRow = typeof users.$inferSelect;

/**
 * Para quem bloqueia por outro caminho (o banimento por trapaça, T27), dentro da mesma transação e das mesmas travas,
 * como a exclusão da F5 faz com o admin.
 */
export interface BlockWithin {
  /** Com a linha do usuário já travada e a conta ativa, antes de cancelar qualquer coisa. */
  validate?: (tx: Tx, user: UserRow) => Promise<void>;
  /** No lugar do registro `player.block`: grava o próprio registro (e o que mais couber) na mesma transação. */
  record?: (tx: Tx, done: { user: UserRow; blockedReason: string; cancelledOrderIds: number[]; cancelledBidIds: number[] }) => Promise<void>;
}

/**
 * Bloquear e desbloquear (Admin, critérios 25 e 33; T3 da F14). O bloqueado não negocia nem oferta, sai dos rankings e
 * continua dono das ações, recebendo dividendos; entra e lê a própria carteira. Bloquear cancela as ordens abertas
 * (motivo `blocked`) e a oferta do IPO, se o IPO está aberto, pelos ganchos que o `market` e o `ipo` registraram.
 *
 * Travas, na ordem do jogo: a linha do usuário (e, se é admin, a de todos os admins ativos, em ordem de id, como a
 * exclusão e a troca de papel da F5; proposta 5), a temporada (compartilhada), os clubes das ordens (em ordem de
 * ticker) e a carteira.
 */
@Injectable()
export class BlockService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly clock: Clock,
    private readonly log: AdminLogService,
    private readonly hooks: AccountClosureHooks,
  ) {}

  async block(adminId: string, targetId: string, reason: string, within: BlockWithin = {}): Promise<BlockResponse> {
    if (adminId === targetId) throw self();
    const now = this.clock.now();
    return withTransaction(this.db, async (tx) => {
      const othersActive = await lockAdminsAndCountOthers(tx, targetId);
      const [user] = await tx.db.select().from(users).where(eq(users.id, targetId));
      if (!user || user.status === "deleted") throw notFound();
      if (user.status === "blocked") throw new DomainError("already_blocked", 409, ADMIN_ERROR_MESSAGES.already_blocked);
      if (user.role === "admin" && othersActive === 0) throw accountError("last_admin");
      await within.validate?.(tx, user);

      let cancelledOrders = 0;
      let cancelledBids = 0;
      let cancelledOrderIds: number[] = [];
      let cancelledBidIds: number[] = [];
      const season = await currentSeason(tx.db);
      const wallet = season ? await this.walletOf(tx, season.id, targetId) : undefined;
      // na temporada encerrada (inclusive a que encerrou enquanto a trava era esperada) o bloqueio não mexe em nada dela
      if (season && wallet && season.status !== "closed" && (await lockSeason(tx, season.id, "share")).status !== "closed") {
        await lockClubs(tx, season.id, await this.hooks.clubsToLock(tx, wallet.id));
        await lockWallets(tx, [wallet.id]);
        const before = await this.openCounts(tx, wallet.id);
        await this.hooks.cancelOpen(tx, wallet.id, "blocked", now);
        const after = await this.openCounts(tx, wallet.id);
        cancelledOrderIds = before.orders.filter((id) => !after.orders.includes(id));
        cancelledBidIds = before.bids.filter((id) => !after.bids.includes(id));
        cancelledOrders = cancelledOrderIds.length;
        cancelledBids = cancelledBidIds.length;
      }
      await tx.db.update(users).set({ status: "blocked", blockedReason: reason }).where(eq(users.id, targetId));
      if (within.record) {
        await within.record(tx, { user, blockedReason: reason, cancelledOrderIds, cancelledBidIds });
        return { status: "blocked", cancelledOrders, cancelledBids };
      }
      await this.log.record(tx, {
        actorId: adminId,
        action: "player.block",
        targetType: "player",
        targetId,
        reason,
        before: { status: user.status, blockedReason: user.blockedReason },
        after: { status: "blocked", blockedReason: reason, cancelledOrderIds, cancelledBidIds },
      });
      return { status: "blocked", cancelledOrders, cancelledBids };
    });
  }

  async unblock(adminId: string, targetId: string, reason: string): Promise<BlockResponse> {
    if (adminId === targetId) throw self();
    return withTransaction(this.db, async (tx) => {
      await lockAdminsAndCountOthers(tx, targetId);
      const [user] = await tx.db.select().from(users).where(eq(users.id, targetId));
      if (!user || user.status === "deleted") throw notFound();
      if (user.status !== "blocked") throw new DomainError("not_blocked", 409, ADMIN_ERROR_MESSAGES.not_blocked);
      await tx.db.update(users).set({ status: "active", blockedReason: null }).where(eq(users.id, targetId));
      await this.log.record(tx, {
        actorId: adminId,
        action: "player.unblock",
        targetType: "player",
        targetId,
        reason,
        before: { status: "blocked", blockedReason: user.blockedReason },
        after: { status: "active" },
      });
      return { status: "active", cancelledOrders: 0, cancelledBids: 0 };
    });
  }

  private async walletOf(tx: Tx, seasonId: number, userId: string) {
    const [wallet] = await tx.db
      .select({ id: wallets.id })
      .from(wallets)
      .where(and(eq(wallets.seasonId, seasonId), eq(wallets.userId, userId)));
    return wallet;
  }

  /** Os ids das ordens abertas e das ofertas ativas da carteira. */
  private async openCounts(tx: Tx, walletId: number): Promise<{ orders: number[]; bids: number[] }> {
    const o = await tx.db.select({ id: orders.id }).from(orders).where(and(eq(orders.walletId, walletId), eq(orders.status, "open"))).orderBy(orders.id);
    const b = await tx.db.select({ id: ipoBids.id }).from(ipoBids).where(and(eq(ipoBids.walletId, walletId), eq(ipoBids.status, "active"))).orderBy(ipoBids.id);
    return { orders: o.map((r) => Number(r.id)), bids: b.map((r) => Number(r.id)) };
  }
}
