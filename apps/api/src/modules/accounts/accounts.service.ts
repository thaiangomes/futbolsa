import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { isReservedNickname, type MeResponse, type PublicPlayer } from "@futbolsa/contracts";
import type { AuthIdentity, ResolvedUser } from "../../infra/auth-adapter/index.js";
import { Clock } from "../../infra/clock/index.js";
import { DB, type Database, lockSeason, type Tx, withTransaction } from "../../infra/db/index.js";
import { authIdentities, invites, seasons, users, wallets } from "../../infra/db/schema/index.js";
import { currentSeason as openSeason } from "../admin/current-season.js";
import { PortfolioLedger } from "../portfolio/index.js";
import { AccountsConfig } from "./accounts.config.js";
import { accountError, mapUniqueViolation } from "./errors.js";
import { creditSeasonStart, SEASON_START_CASH } from "./season-start.js";

/** Temporadas em que quem ainda não tem carteira vai para a entrada no meio (F11). */
const ENTRY_STATUSES = new Set(["ipo_closed", "trading"]);

/** Conta e login: cadastro, situação da conta, apelido e o caixa do início da temporada. */
@Injectable()
export class AccountsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly clock: Clock,
    private readonly ledger: PortfolioLedger,
    private readonly config: AccountsConfig,
  ) {}

  /** `GET /me`: sem conta, só se o e-mail da própria pessoa está liberado; com conta, a situação dela. */
  async me(identity: AuthIdentity, user: ResolvedUser | null): Promise<MeResponse> {
    if (!user) return { registered: false, invited: await this.isInvited(identity.email) };
    const [row] = await this.db.select().from(users).where(eq(users.id, user.id));
    const season = await this.currentSeason(this.db);
    let seasonView: Extract<MeResponse, { registered: true }>["season"] = null;
    if (season) {
      const [wallet] = await this.db
        .select({ id: wallets.id })
        .from(wallets)
        .where(and(eq(wallets.seasonId, season.id), eq(wallets.userId, user.id)));
      seasonView = {
        year: season.year,
        status: season.status as never,
        ipoOpensAt: season.ipoOpensAt?.toISOString() ?? null,
        hasWallet: Boolean(wallet),
        needsEntry: !wallet && ENTRY_STATUSES.has(season.status),
      };
    }
    return {
      registered: true,
      id: row!.id,
      nickname: row!.nickname!,
      email: row!.email!,
      role: row!.role as ResolvedUser["role"],
      status: row!.status as ResolvedUser["status"],
      termsAcceptedAt: row!.termsAcceptedAt!.toISOString(),
      season: seasonView,
    };
  }

  /**
   * `POST /me`: cria a conta do jogo (Conta e login, critérios 1, 2, 13 e 14). Só com o e-mail
   * liberado pelo admin, exceto o do primeiro admin; com o IPO aberto, a conta já nasce com
   * R$ 100.000,00. O jogo guarda só e-mail, apelido e a data do aceite (critério 20).
   */
  async register(identity: AuthIdentity, nickname: string): Promise<ResolvedUser> {
    if (isReservedNickname(nickname)) throw accountError("nickname_reserved");
    const now = this.clock.now();
    const isBootstrapAdmin = this.config.bootstrapAdminEmail === identity.email;
    try {
      return await withTransaction(this.db, async (tx) => {
        const [linked] = await tx.db
          .select({ userId: authIdentities.userId })
          .from(authIdentities)
          .where(and(eq(authIdentities.provider, identity.provider), eq(authIdentities.subject, identity.subject)));
        if (linked) throw accountError("already_registered");
        if (!isBootstrapAdmin && !(await this.isInvited(identity.email, tx))) throw accountError("invite_required");

        // A temporada é travada em modo compartilhado antes de criar a conta: assim a abertura
        // do IPO (exclusiva) vê esta conta, ou esta conta vê o IPO já aberto. Nunca as duas falham.
        // Tem de ser a mesma linha que a abertura escolhe (a mais nova não encerrada): travar outra (por exemplo uma
        // encerrada de ano maior) deixaria a abertura passar por cima deste cadastro, e a conta ficaria sem carteira.
        const current = await openSeason(tx.db);
        const season = current ? await lockSeason(tx, current.id, "share") : undefined;

        const [user] = await tx.db
          .insert(users)
          .values({
            email: identity.email,
            nickname,
            role: isBootstrapAdmin ? "admin" : "player",
            termsAcceptedAt: now,
            createdAt: now,
          })
          .returning({ id: users.id, role: users.role, status: users.status });
        await tx.db
          .insert(authIdentities)
          .values({ provider: identity.provider, subject: identity.subject, userId: user!.id, createdAt: now });
        await tx.db.update(invites).set({ usedAt: now }).where(eq(invites.email, identity.email));
        if (season?.status === "ipo_open") {
          await this.ledger.openWallet(tx, {
            seasonId: season.id,
            owner: { type: "user", userId: user!.id },
            at: now,
            entryMode: "ipo",
            initialCash: SEASON_START_CASH,
          });
        }
        return user as ResolvedUser;
      });
    } catch (error) {
      throw mapUniqueViolation(error);
    }
  }

  /** `PATCH /me/nickname`: troca quando quiser, se o novo estiver livre (critério 10). */
  async changeNickname(userId: string, nickname: string): Promise<void> {
    if (isReservedNickname(nickname)) throw accountError("nickname_reserved");
    try {
      await this.db.update(users).set({ nickname }).where(and(eq(users.id, userId), ne(users.status, "deleted")));
    } catch (error) {
      throw mapUniqueViolation(error);
    }
  }

  /** `GET /players/:nickname`, público: só o apelido atual, nunca e-mail nem id (critério 11). */
  async publicPlayer(nickname: string): Promise<Pick<PublicPlayer, "nickname"> | null> {
    const [row] = await this.db
      .select({ nickname: users.nickname })
      .from(users)
      .where(and(sql`lower(${users.nickname}) = lower(${nickname})`, ne(users.status, "deleted")));
    return row?.nickname ? { nickname: row.nickname } : null;
  }

  /** R$ 100.000,00 para todas as contas na abertura das ofertas do IPO. Chamado pela F8. */
  creditSeasonStart(tx: Tx, seasonId: number, at: Date): Promise<number> {
    return creditSeasonStart(this.ledger, tx, seasonId, at);
  }

  /** A temporada atual: a de ano mais recente. */
  private async currentSeason(db: Database | Tx["db"]) {
    const [season] = await db.select().from(seasons).orderBy(desc(seasons.year)).limit(1);
    return season;
  }

  private async isInvited(email: string, tx?: Tx): Promise<boolean> {
    const [row] = await (tx?.db ?? this.db).select({ email: invites.email }).from(invites).where(eq(invites.email, email));
    return Boolean(row);
  }
}
