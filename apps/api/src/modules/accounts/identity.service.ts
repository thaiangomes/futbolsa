import { Inject, Injectable } from "@nestjs/common";
import { and, eq, ne, sql } from "drizzle-orm";
import type { AuthIdentity, ResolvedUser } from "../../infra/auth-adapter/index.js";
import { UserResolver } from "../../infra/auth-adapter/index.js";
import { DB, type Database } from "../../infra/db/index.js";
import { authIdentities, users } from "../../infra/db/schema/index.js";

const userColumns = { id: users.id, role: users.role, status: users.status };

/**
 * Qual usuário do jogo está por trás de uma identidade do login. Uma conta por e-mail (Conta e
 * login, critério 3): uma identidade nova, com o e-mail **confirmado** igual ao de uma conta não
 * excluída, é ligada a ela. Sem a confirmação, nunca liga, para ninguém tomar a conta de outra
 * pessoa criando um login com o e-mail dela.
 */
@Injectable()
export class IdentityService extends UserResolver {
  constructor(@Inject(DB) private readonly db: Database) {
    super();
  }

  async resolve(identity: AuthIdentity): Promise<ResolvedUser | null> {
    const linked = await this.findLinked(identity);
    if (linked) return linked;
    if (!identity.emailVerified) return null;

    const [owner] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(sql`lower(${users.email}) = ${identity.email}`, ne(users.status, "deleted")));
    if (!owner) return null;
    // Duas chamadas ao mesmo tempo com a identidade nova ligam uma vez só.
    await this.db
      .insert(authIdentities)
      .values({ provider: identity.provider, subject: identity.subject, userId: owner.id })
      .onConflictDoNothing();
    return this.findLinked(identity);
  }

  private async findLinked(identity: AuthIdentity): Promise<ResolvedUser | null> {
    const [row] = await this.db
      .select(userColumns)
      .from(authIdentities)
      .innerJoin(users, eq(users.id, authIdentities.userId))
      .where(and(eq(authIdentities.provider, identity.provider), eq(authIdentities.subject, identity.subject)));
    return (row as ResolvedUser | undefined) ?? null;
  }
}
