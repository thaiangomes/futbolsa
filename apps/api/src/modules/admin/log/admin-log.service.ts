import { Injectable, Module } from "@nestjs/common";
import { Clock } from "../../../infra/clock/index.js";
import type { Tx } from "../../../infra/db/index.js";
import { adminLog } from "../../../infra/db/schema/index.js";

/** Uma ação do admin para o registro (Admin, critério 33). */
export interface AdminLogEntry {
  /** O admin que fez a ação. */
  actorId: string;
  /** O que foi feito, por exemplo `invite.create` ou `player.role`. */
  action: string;
  targetType?: string;
  targetId?: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

/**
 * Registro do admin: toda ação grava autor, horário, antes, depois e motivo. Recebe o `tx` da
 * ação, então se a ação desfaz, a linha some junto; a hora vem do relógio da API.
 *
 * Versão mínima, escrita na F5 (ramo `claude/f5-login-contas`) para os convites e os papéis. A
 * T2 da F7 completa: a tabela das ações que exigem motivo (`reasons.ts`) e o `listLog`.
 */
@Injectable()
export class AdminLogService {
  constructor(private readonly clock: Clock) {}

  async record(tx: Tx, entry: AdminLogEntry): Promise<void> {
    await tx.db.insert(adminLog).values({
      actorId: entry.actorId,
      at: this.clock.now(),
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      before: entry.before ?? null,
      after: entry.after ?? null,
      reason: entry.reason,
    });
  }
}

/** O registro do admin para os outros módulos (o `accounts` usa nos convites e papéis). */
@Module({ providers: [AdminLogService], exports: [AdminLogService] })
export class AdminLogModule {}
