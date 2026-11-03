import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { COMMON_ERROR_MESSAGES, type Invite } from "@futbolsa/contracts";
import { normalizeEmail } from "../../infra/auth-adapter/index.js";
import { Clock } from "../../infra/clock/index.js";
import { DB, type Database, withTransaction } from "../../infra/db/index.js";
import { invites, users } from "../../infra/db/schema/index.js";
import { DomainError } from "../../infra/http/index.js";
import { AdminLogService } from "../admin/log/index.js";
import { AccountsConfig, emailFingerprint } from "./accounts.config.js";
import { accountError } from "./errors.js";

/**
 * A lista de e-mails liberados pelo admin (Conta e login, critérios 1, 19 e 23). Só um e-mail
 * liberado cria conta; o admin retira a liberação enquanto o e-mail não criou conta. Cada
 * liberação e retirada vai para o registro do admin, com o e-mail embaralhado.
 */
@Injectable()
export class InvitesService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly clock: Clock,
    private readonly log: AdminLogService,
    private readonly config: AccountsConfig,
  ) {}

  async list(): Promise<Invite[]> {
    const rows = await this.db.select().from(invites).orderBy(asc(invites.createdAt), asc(invites.email));
    return rows.map((r) => ({ email: r.email, createdAt: r.createdAt.toISOString(), usedAt: r.usedAt?.toISOString() ?? null }));
  }

  async create(actorId: string, emails: string[]) {
    const now = this.clock.now();
    const wanted = [...new Set(emails.map(normalizeEmail))];
    return withTransaction(this.db, async (tx) => {
      const registered = await tx.db
        .select({ email: sql<string>`lower(${users.email})` })
        .from(users)
        .where(and(inArray(sql`lower(${users.email})`, wanted), ne(users.status, "deleted")));
      const alreadyRegistered = registered.map((r) => r.email).sort();
      const toInvite = wanted.filter((e) => !alreadyRegistered.includes(e));
      const inserted = toInvite.length
        ? await tx.db
            .insert(invites)
            .values(toInvite.map((email) => ({ email, invitedBy: actorId, createdAt: now })))
            .onConflictDoNothing()
            .returning({ email: invites.email })
        : [];
      const invited = inserted.map((r) => r.email).sort();
      for (const email of invited) {
        await this.log.record(tx, {
          actorId,
          action: "invite.create",
          targetType: "invite",
          targetId: emailFingerprint(this.config.adminLogEmailKey, email),
        });
      }
      const alreadyInvited = toInvite.filter((e) => !invited.includes(e)).sort();
      return { invited, alreadyInvited, alreadyRegistered };
    });
  }

  async revoke(actorId: string, email: string): Promise<void> {
    const target = normalizeEmail(email);
    await withTransaction(this.db, async (tx) => {
      const [row] = await tx.db.select().from(invites).where(eq(invites.email, target)).for("update");
      if (!row) throw new DomainError("not_found", 404, COMMON_ERROR_MESSAGES.not_found);
      if (row.usedAt) throw accountError("invite_used");
      await tx.db.delete(invites).where(eq(invites.email, target));
      await this.log.record(tx, {
        actorId,
        action: "invite.revoke",
        targetType: "invite",
        targetId: emailFingerprint(this.config.adminLogEmailKey, target),
      });
    });
  }
}
