import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, desc, eq, gt, ne, or, sql } from "drizzle-orm";
import type { DeleteMeResponse } from "@futbolsa/contracts";
import { AuthVerifier } from "../../infra/auth-adapter/index.js";
import { Clock } from "../../infra/clock/index.js";
import { DB, type Database, lockClubs, lockSeason, lockWallets, type Tx, withTransaction } from "../../infra/db/index.js";
import {
  authIdentities,
  invites,
  playerNotices,
  positions,
  seasonClubs,
  seasons,
  users,
  wallets,
} from "../../infra/db/schema/index.js";
import { RealtimeGateway } from "../../infra/realtime/index.js";
import { PortfolioLedger } from "../portfolio/index.js";
import { AccountClosureHooks } from "./closure-hooks.js";
import { accountError } from "./errors.js";
import { lockAdminsAndCountOthers } from "./roles.service.js";

/** Login feito há no máximo 15 minutos para excluir a conta (decisão do Thaian em 2026-10-31). */
export const REAUTH_WINDOW_MS = 15 * 60_000;

type SeasonRow = typeof seasons.$inferSelect;
type UserRow = typeof users.$inferSelect;

/** Ganchos da exclusão feita pelo admin (F14, T4), dentro da transação da exclusão. */
export interface DeleteAccountOptions {
  validate?: (tx: Tx, user: UserRow) => Promise<void> | void;
  record?: (tx: Tx, info: { user: UserRow; walletCloseout: DeleteMeResponse["walletCloseout"] }) => Promise<void>;
}

/**
 * Exclusão da conta (Conta e login, critérios 22 e 23; Admin, critério 26). Pode ser pedida a
 * qualquer momento, por direito da LGPD, e nunca é recusada pelo momento da temporada (decisão
 * do Thaian em 2026-10-31). Duas partes:
 * - os dados somem na hora: conta marcada como excluída, e-mail e apelido apagados, convite
 *   retirado e, depois do `COMMIT`, as conexões do tempo real derrubadas e a identidade apagada
 *   no sistema de login;
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
    private readonly realtime: RealtimeGateway,
  ) {}

  /**
   * `options` é do admin (F14, T4): `validate` roda com a conta travada e antes de qualquer mudança (recusa por exceção);
   * `record` roda na mesma transação, depois da exclusão, com o resultado do encerramento da carteira (o registro do admin).
   */
  async deleteAccount(userId: string, options: DeleteAccountOptions = {}): Promise<DeleteMeResponse> {
    const now = this.clock.now();
    const closeout = await withTransaction(this.db, async (tx) => {
      const user = await this.lockUser(tx, userId);
      if (options.validate) await options.validate(tx, user);
      const season = await this.currentSeason(tx);
      const wallet = season ? await this.walletOf(tx, season.id, userId) : undefined;
      let result: DeleteMeResponse["walletCloseout"] = "done";
      // a temporada encerrada já deixou a carteira em R$ 0,00 e sem ações, e nada mais muda nela (F15, T7): o histórico,
      // o anual ("conta excluída") e o `season_results` ficam como estão
      if (season && wallet && season.status !== "closed") {
        // A leitura sem trava é um atalho; quem decide de fato é o `closeWallet`, com a temporada travada.
        if (await this.awaitingSettlement(tx, season, now)) result = "after_ipo_settlement";
        else if (!(await this.closeWallet(tx, season.id, wallet, now))) result = "after_ipo_settlement";
      }
      await tx.db
        .update(users)
        .set({ status: "deleted", email: null, nickname: null, deletedAt: now })
        .where(eq(users.id, userId));
      if (user.email) await tx.db.delete(invites).where(eq(invites.email, user.email));
      // os avisos de trapaça são dado da conta: somem com ela (o relatório do admin guarda só ids)
      await tx.db.delete(playerNotices).where(eq(playerNotices.userId, userId));
      if (options.record) await options.record(tx, { user, walletCloseout: result });
      tx.afterCommit(async () => {
        this.realtime.disconnectUser(userId);
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
        // a tarefa pula a temporada encerrada (F15, T7)
        if (!season || season.status === "closed" || (await this.awaitingSettlement(tx, season, now))) return false;
        const [wallet] = await tx.db.select().from(wallets).where(eq(wallets.id, walletId));
        return this.closeWallet(tx, seasonId, wallet!, now);
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
   *
   * `FOR NO KEY UPDATE`, e não `FOR UPDATE`: a abertura do IPO trava a temporada e, ao criar a
   * carteira, a chave estrangeira pede `KEY SHARE` na linha do usuário. Com `FOR UPDATE` aqui (que
   * vem antes da temporada), as duas esperariam uma pela outra (*deadlock*).
   */
  private async lockUser(tx: Tx, userId: string) {
    const othersActive = await lockAdminsAndCountOthers(tx, userId);
    const [user] = await tx.db.select().from(users).where(eq(users.id, userId));
    if (!user || user.status === "deleted") throw accountError("account_deleted");
    if (user.role === "admin" && user.status === "active" && othersActive === 0) throw accountError("last_admin");
    return user;
  }

  /**
   * Entre o fechamento e a liquidação do IPO: falta o resultado de algum clube listado. O fechamento é o
   * horário (`ipo_closes_at`), não a passada da tarefa que muda o status: com `ipo_open` e `at` já no
   * horário de fechamento ou depois, as ofertas também não podem mais sair (critério 14 e proposta 8 do
   * IPO; o adiamento só vale antes desse horário, então ele não volta atrás).
   */
  private async awaitingSettlement(tx: Tx, season: SeasonRow, at: Date): Promise<boolean> {
    if (season.status === "ipo_open") return season.ipoClosesAt !== null && at.getTime() >= season.ipoClosesAt.getTime();
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
   *
   * Devolve `false`, sem mexer em nada, se com a temporada já travada ela está entre o fechamento e a
   * liquidação do IPO: o status lido antes, sem trava, pode ter mudado enquanto a trava era esperada (o
   * pedido leu `ipo_open` no instante em que o IPO fechava). Aí as ofertas não podem mais sair, e a
   * carteira fica para o `account-closeout`, como no pedido que já chega com o IPO fechado.
   */
  private async closeWallet(tx: Tx, seasonId: number, wallet: typeof wallets.$inferSelect, at: Date): Promise<boolean> {
    const season = await lockSeason(tx, seasonId, "share");
    // encerrada enquanto a trava era esperada: a carteira já foi zerada no encerramento
    if (season.status === "closed") return true;
    if (await this.awaitingSettlement(tx, season, at)) return false;
    await lockClubs(tx, seasonId, await this.hooks.clubsToLock(tx, wallet.id));
    const [treasury] = await tx.db
      .select({ id: wallets.id })
      .from(wallets)
      .where(and(eq(wallets.seasonId, seasonId), eq(wallets.ownerType, "treasury")));
    await lockWallets(tx, treasury ? [wallet.id, treasury.id] : [wallet.id]);
    // O mesmo instante da decisão acima: o gancho do IPO não pode achar o período fechado depois de ela o achar aberto.
    await this.hooks.cancelOpen(tx, wallet.id, "deleted", at);

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
    return true;
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
