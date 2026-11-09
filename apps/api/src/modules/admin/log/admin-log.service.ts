import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { ADMIN_ERROR_MESSAGES, type AdminLogQuery, type AdminLogResponse } from "@futbolsa/contracts";
import { Clock } from "../../../infra/clock/index.js";
import { DB, type Database, type Tx } from "../../../infra/db/index.js";
import { adminLog, users } from "../../../infra/db/schema/index.js";
import { DomainError } from "../../../infra/http/index.js";
import { reasonRequired } from "./reasons.js";

/** Uma ação do admin para o registro (Admin, critério 33). */
export interface AdminLogEntry {
  /** O admin que fez a ação. */
  actorId: string;
  /** O que foi feito, por exemplo `invite.create` ou `player.role`; precisa estar em `ADMIN_ACTIONS`. */
  action: string;
  targetType?: string;
  targetId?: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

/** Algo com cara de e-mail. O e-mail embaralhado dos convites (hex do HMAC) não casa. */
const EMAIL_LIKE = /\S+@\S+\.\S+/;

/** Procura, em qualquer profundidade, uma string com cara de e-mail (nas chaves e nos valores). */
function containsEmail(value: unknown): boolean {
  if (typeof value === "string") return EMAIL_LIKE.test(value);
  if (Array.isArray(value)) return value.some(containsEmail);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(([key, v]) => EMAIL_LIKE.test(key) || containsEmail(v));
  }
  return false;
}

/**
 * Registro do admin: toda ação grava autor, horário, antes, depois e motivo. Recebe o `tx` da
 * ação, então se a ação desfaz, a linha some junto; a hora vem do relógio da API. O registro não
 * se edita nem se apaga (gatilho `admin_log_history` da migração 0001).
 *
 * A versão mínima veio da F5 (convites e papéis); a T2 da F7 completou a tabela das ações que
 * exigem motivo (`reasons.ts`), a recusa sem motivo, a trava de e-mail e o `listLog`.
 */
@Injectable()
export class AdminLogService {
  constructor(
    private readonly clock: Clock,
    @Inject(DB) private readonly db: Database,
  ) {}

  async record(tx: Tx, entry: AdminLogEntry): Promise<void> {
    // Tudo é conferido antes de gravar: a recusa não deixa linha nenhuma.
    const required = reasonRequired(entry.action);
    const reason = entry.reason?.trim() || undefined;
    if (required && !reason) {
      throw new DomainError("reason_required", 400, ADMIN_ERROR_MESSAGES.reason_required);
    }
    // O registro não se apaga, e a exclusão de conta precisa apagar o e-mail: nenhum e-mail entra
    // no antes nem no depois. Quem chama guarda ids, apelidos ou o e-mail embaralhado.
    // O motivo é texto livre do admin: e-mail ali é engano de quem digitou, então volta 400 com a explicação.
    if (reason && containsEmail(reason)) {
      throw new DomainError("reason_has_email", 400, ADMIN_ERROR_MESSAGES.reason_has_email);
    }
    if (containsEmail(entry.before) || containsEmail(entry.after)) {
      throw new Error(
        `O registro do admin não guarda e-mail (ação "${entry.action}"): use o id, o apelido ou o e-mail embaralhado por emailFingerprint.`,
      );
    }
    await tx.db.insert(adminLog).values({
      actorId: entry.actorId,
      at: this.clock.now(),
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      before: entry.before ?? null,
      after: entry.after ?? null,
      reason,
    });
  }

  /**
   * O registro para a tela do admin: filtros por autor, ação e período (`from` inclusive, `to`
   * exclusive), do mais novo para o mais antigo, em páginas. O autor vem com o apelido, que é
   * nulo quando a conta foi excluída.
   */
  async listLog(query: AdminLogQuery): Promise<AdminLogResponse> {
    const filters: SQL[] = [];
    if (query.actorId) filters.push(eq(adminLog.actorId, query.actorId));
    if (query.action) filters.push(eq(adminLog.action, query.action));
    if (query.from) filters.push(gte(adminLog.at, new Date(query.from)));
    if (query.to) filters.push(lt(adminLog.at, new Date(query.to)));
    const where = filters.length ? and(...filters) : undefined;

    const [rows, [count]] = await Promise.all([
      this.db
        .select({ log: adminLog, nickname: users.nickname })
        .from(adminLog)
        .innerJoin(users, eq(users.id, adminLog.actorId))
        .where(where)
        .orderBy(desc(adminLog.at), desc(adminLog.id))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),
      this.db.select({ n: sql<number>`count(*)::int` }).from(adminLog).where(where),
    ]);

    return {
      entries: rows.map(({ log, nickname }) => ({
        id: log.id,
        actor: { id: log.actorId, nickname },
        at: log.at.toISOString(),
        action: log.action,
        targetType: log.targetType,
        targetId: log.targetId,
        before: log.before,
        after: log.after,
        reason: log.reason,
      })),
      page: query.page,
      pageSize: query.pageSize,
      total: count!.n,
    };
  }
}
