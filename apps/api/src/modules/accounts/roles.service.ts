import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, ne, or, sql } from "drizzle-orm";
import { COMMON_ERROR_MESSAGES, type UserRole } from "@futbolsa/contracts";
import { DB, type Database, type Tx, withTransaction } from "../../infra/db/index.js";
import { users } from "../../infra/db/schema/index.js";
import { DomainError } from "../../infra/http/index.js";
import { RealtimeGateway } from "../../infra/realtime/index.js";
import { AdminLogService } from "../admin/log/index.js";
import { accountError } from "./errors.js";

/**
 * Trava os admins ativos e a conta dada, em ordem de id (`FOR NO KEY UPDATE`, como na exclusão),
 * e devolve quantos admins ativos sobram fora dela. Serializa a troca de papel e a exclusão de
 * admins: dois admins tirando o papel um do outro ao mesmo tempo não deixam o jogo sem nenhum.
 */
export async function lockAdminsAndCountOthers(tx: Tx, userId: string): Promise<number> {
  await tx.db
    .select({ id: users.id })
    .from(users)
    .where(or(and(eq(users.role, "admin"), eq(users.status, "active")), eq(users.id, userId)))
    .orderBy(asc(users.id))
    .for("no key update");
  const [row] = await tx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.role, "admin"), eq(users.status, "active"), ne(users.id, userId)));
  return row!.n;
}

/**
 * Papéis (Admin, critérios 31, 32 e 33): um admin dá ou tira o papel de admin, com motivo. Depois
 * do `COMMIT`, as conexões do tempo real da pessoa caem e reabrem com o papel novo: o WebSocket
 * só confere o papel no `auth`, e quem perdeu o papel não pode seguir no canal `admin`.
 */
@Injectable()
export class RolesService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly log: AdminLogService,
    private readonly realtime: RealtimeGateway,
  ) {}

  async setRole(actorId: string, userId: string, role: UserRole, reason: string): Promise<void> {
    await withTransaction(this.db, async (tx) => {
      const othersActive = await lockAdminsAndCountOthers(tx, userId);
      const [user] = await tx.db.select().from(users).where(eq(users.id, userId));
      if (!user || user.status === "deleted") throw new DomainError("not_found", 404, COMMON_ERROR_MESSAGES.not_found);
      if (user.role === role) return;
      if (role === "admin" && user.status !== "active") {
        throw new DomainError("invalid_input", 400, "Conta bloqueada não pode virar admin.", ["role"]);
      }
      // Tirar o papel do último admin ativo deixaria o jogo sem nenhum (critério 32).
      if (role === "player" && user.status === "active" && othersActive === 0) throw accountError("last_admin");
      await tx.db.update(users).set({ role }).where(eq(users.id, userId));
      await this.log.record(tx, {
        actorId,
        action: "player.role",
        targetType: "user",
        targetId: userId,
        before: { role: user.role },
        after: { role },
        reason,
      });
      tx.afterCommit(() => {
        this.realtime.disconnectUser(userId);
      });
    });
  }
}
