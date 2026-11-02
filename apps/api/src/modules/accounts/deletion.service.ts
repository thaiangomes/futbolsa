import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, desc, eq, gt, ne, or, sql } from "drizzle-orm";
import type { DeleteMeResponse } from "@futbolsa/contracts";
import { AuthVerifier } from "../../infra/auth-adapter/index.js";
import { Clock } from "../../infra/clock/index.js";
import { DB, type Database, lockClubs, lockSeason, lockWallets, type Tx, withTransaction } from "../../infra/db/index.js";
import {
  authIdentities,
  invites,
  positions,
  seasonClubs,
  seasons,
  users,
  wallets,
} from "../../infra/db/schema/index.js";
import { PortfolioLedger } from "../portfolio/index.js";
import { AccountClosureHooks } from "./closure-hooks.js";
import { accountError } from "./errors.js";

/** Login feito há no máximo 15 minutos para excluir a conta (decisão do Thaian em 2026-10-31). */
export const REAUTH_WINDOW_MS = 15 * 60_000;

type SeasonRow = typeof seasons.$inferSelect;

/**
 * Exclusão da conta (Conta e login, critérios 22 e 23; Admin, critério 26). Pode ser pedida a
 * qualquer momento, por direito da LGPD, e nunca é recusada pelo momento da temporada (decisão
 * do Thaian em 2026-10-31). Duas partes:
 * - os dados somem na hora: conta marcada como excluída, e-mail e apelido apagados, convite
 *   retirado e, depois do `COMMIT`, a identidade apagada no sistema de login;
 * - a carteira da temporada é encerrada na mesma transação (ordens e ofertas canceladas, ações
 *   para a tesouraria, caixa a zero), ou logo depois da liquidação do IPO, se o pedido cai entre
 *   o fechamento e a liquidação, quando as ofertas não podem mais sair sem mudar o rateio dos outros.
 */
@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger("Exclusão");

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly clock: Clock,
    private readonly ledger: PortfolioLedger,
    private readonly hooks: AccountClosureHooks,
    private readonly verifier: AuthVerifier,
  ) {}

  async deleteAccount(userId: string): Promise<DeleteMeResponse> {
    const now = this.clock.now();
    const closeout = await withTransaction(this.db, async (tx) => {
      const user = await this.lockUser(tx, userId);
      const season = await this.currentSeason(tx);
      const wallet = season ? await this.walletOf(tx, season.id, userId) : undefined;
      let result: DeleteMeResponse["walletCloseout"] = "done";
      if (season && wallet) {
        if (await this.awaitingSettlement(tx, season)) result = "after_ipo_settlement";
        else await this.closeWallet(tx, season.id, wallet, now);
      }
      await tx.db
        .update(users)
        .set({ status: "deleted", email: null, nickname: null, deletedAt: now })
        .where(eq(users.id, userId));
      if (user.email) await tx.db.delete(invites).where(eq(invites.email, user.email));
      tx.afterCommit(async () => {
        await this.purgeIdentities(userId);
      });
      return result;
    });
    return { walletCloseout: closeout };
  }

  /**
   * Encerra as carteiras de contas excluídas que ficaram para depois da liquidação do IPO (a
   * tarefa `account-closeout`, a cada minuto). Repetível: carteira já zerada é pulada.
   */
  async closeoutPending(): Promise<number> {
    const now = this.clock.now();
    const pending = await this.db
      .select({ walletId: wallets.id, seasonId: wallets.seasonId })
      .from(wallets)
      .innerJoin(users, eq(users.id, wallets.userId))
      .where(and(eq(users.status, "deleted"), or(ne(wallets.cash, 0), gt(wallets.reservedCash, 0), sql`exists (
        select 1 from futbolsa.positions p where p.wallet_id = ${wallets.id} and p.shares > 0)`)))
      .orderBy(asc(wallets.id));
    let done = 0;
    for (const { walletId, seasonId } of pending) {
      const closed = await withTransaction(this.db, async (tx) => {
        const [season] = await tx.db.select().from(seasons).where(eq(seasons.id, seasonId));
        if (!season || (await this.awaitingSettlement(tx, season))) return false;
        const [wallet] = await tx.db.select().from(wallets).where(eq(wallets.id, walletId));
        await this.closeWallet(tx, seasonId, wallet!, now);
        return true;
      });
      if (closed) done++;
    }
    return done;
  }

  /**
   * Apaga no sistema de login as identidades das contas excluídas e, em seguida, a ligação delas.
   * Roda depois do `COMMIT` da exclusão e, se o login falhar, de novo na tarefa `identity-cleanup`.
   * Enquanto isso o token antigo já é recusado, porque a conta está excluída.
   */
  async purgeIdentities(userId?: string): Promise<number> {
    const rows = await this.db
      .select({ provider: authIdentities.provider, subject: authIdentities.subject })
      .from(authIdentities)
      .innerJoin(users, eq(users.id, authIdentities.userId))
      .where(userId ? and(eq(users.status, "deleted"), eq(users.id, userId)) : eq(users.status, "deleted"));
    let purged = 0;
    for (const row of rows) {
      try {
        await this.verifier.deleteIdentity(row.subject);
      } catch (error) {
        this.logger.warn(`identidade não apagada no login, fica para a próxima rodada: ${(error as Error).message}`);
        continue;
      }
      await this.db
        .delete(authIdentities)
        .where(and(eq(authIdentities.provider, row.provider), eq(authIdentities.subject, row.subject)));
      purged++;
    }
    return purged;
  }

  /**
   * Trava a conta. Se ela é admin, trava todos os admins ativos em ordem de id (a mesma trava da
   * troca de papel), para dois admins não saírem ao mesmo tempo deixando o jogo sem nenhum.
   */
  private async lockUser(tx: Tx, userId: string) {
    const [peek] = await tx.db.select({ role: users.role }).from(users).where(eq(users.id, userId));
    if (peek?.role === "admin") {
      await tx.db
        .select({ id: users.id })
        .from(users)
        .where(or(and(eq(users.role, "admin"), eq(users.status, "active")), eq(users.id, userId)))
        .orderBy(asc(users.id))
        .for("update");
    }
    const [user] = await tx.db.select().from(users).where(eq(users.id, userId)).for("update");
    if (!user || user.status === "deleted") throw accountError("account_deleted");
    if (user.role === "admin" && user.status === "active") {
      const [{ n }] = (await tx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(users)
        .where(and(eq(users.role, "admin"), eq(users.status, "active"), ne(users.id, userId)))) as [{ n: number }];
      if (n === 0) throw accountError("last_admin");
    }
    return user;
  }

  /** Entre o fechamento e a liquidação do IPO: falta o resultado de algum clube listado. */
  private async awaitingSettlement(tx: Tx, season: SeasonRow): Promise<boolean> {
    if (season.status !== "ipo_closed") return false;
    const [{ missing }] = (await tx.db
      .select({ missing: sql<number>`count(*)::int` })
      .from(seasonClubs)
      .where(
        and(
          eq(seasonClubs.seasonId, season.id),
          sql`not exists (select 1 from futbolsa.ipo_results r
                where r.season_id = ${seasonClubs.seasonId} and r.club_id = ${seasonClubs.clubId})`,
        ),
      )) as [{ missing: number }];
    return missing > 0;
  }

  /**
   * Encerra a carteira, na ordem das travas (temporada, clubes das ordens abertas, carteira e
   * tesouraria por último): cancela ordens e ofertas pelos ganchos, manda as ações para a
   * tesouraria e zera o caixa. Se o caixa estava negativo por estorno, a dívida some com a conta.
   */
  private async closeWallet(tx: Tx, seasonId: number, wallet: typeof wallets.$inferSelect, at: Date): Promise<void> {
    await lockSeason(tx, seasonId, "share");
    await lockClubs(tx, seasonId, await this.hooks.clubsToLock(tx, wallet.id));
    const [treasury] = await tx.db
      .select({ id: wallets.id })
      .from(wallets)
      .where(and(eq(wallets.seasonId, seasonId), eq(wallets.ownerType, "treasury")));
    await lockWallets(tx, treasury ? [wallet.id, treasury.id] : [wallet.id]);
    await this.hooks.cancelOpen(tx, wallet.id, "deleted");

    const held = await tx.db
      .select({
        clubId: positions.clubId,
        shares: positions.shares,
        reservedShares: positions.reservedShares,
        price: sql<number | null>`coalesce(${seasonClubs.lastPrice}, ${seasonClubs.ipoPrice})`.mapWith(
          (v) => (v === null ? null : Number(v)),
        ),
      })
      .from(positions)
      .leftJoin(seasonClubs, and(eq(seasonClubs.clubId, positions.clubId), eq(seasonClubs.seasonId, seasonId)))
      .where(and(eq(positions.walletId, wallet.id), gt(positions.shares, 0)))
      .orderBy(asc(positions.clubId));
    const ref = { type: "account_deleted", id: wallet.id };
    for (const p of held) {
      if (p.reservedShares > 0) throw new Error(`ações ainda reservadas no clube ${p.clubId}: falta o gancho que cancela as ordens`);
      if (!treasury) throw new Error(`temporada ${seasonId} sem tesouraria para receber as ações`);
      if (!p.price) throw new Error(`clube ${p.clubId} sem preço exibido nem preço do IPO`);
      await this.ledger.post(tx, {
        walletId: wallet.id, at, kind: "account_deleted", clubId: p.clubId, sharesDelta: -p.shares, costBasis: "debit", ref,
      });
      await this.ledger.post(tx, {
        walletId: treasury.id, at, kind: "account_deleted", clubId: p.clubId, sharesDelta: p.shares,
        costBasis: "purchase", price: p.price, ref,
      });
    }
    const [current] = await tx.db.select().from(wallets).where(eq(wallets.id, wallet.id));
    if (current!.reservedCash !== 0) throw new Error("caixa ainda reservado: falta o gancho que cancela as ordens e ofertas");
    if (current!.cash !== 0) {
      await this.ledger.post(tx, { walletId: wallet.id, at, kind: "account_deleted", cashDelta: -current!.cash, ref });
    }
  }

  private async currentSeason(tx: Tx): Promise<SeasonRow | undefined> {
    const [season] = await tx.db.select().from(seasons).orderBy(desc(seasons.year)).limit(1);
    return season;
  }

  private async walletOf(tx: Tx, seasonId: number, userId: string) {
    const [wallet] = await tx.db
      .select()
      .from(wallets)
      .where(and(eq(wallets.seasonId, seasonId), eq(wallets.userId, userId)));
    return wallet;
  }
}
