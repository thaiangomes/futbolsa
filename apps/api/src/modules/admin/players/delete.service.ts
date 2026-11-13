import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { ADMIN_ERROR_MESSAGES, type DeletePlayerBody, type DeletePlayerResponse } from "@futbolsa/contracts";
import { DB, type Database } from "../../../infra/db/index.js";
import { users } from "../../../infra/db/schema/index.js";
import { DomainError } from "../../../infra/http/index.js";
import { AccountsConfig, emailFingerprint } from "../../accounts/accounts.config.js";
import { AccountDeletionService } from "../../accounts/deletion.service.js";
import { AdminLogService } from "../log/index.js";

/**
 * Excluir pelo admin (Admin, critério 26; T4 da F14), inclusive o pedido do titular que não consegue mais entrar. É a
 * mesma exclusão da F5 (`AccountDeletionService.deleteAccount`): ela apaga e-mail e apelido, encerra a carteira (ações
 * para a tesouraria, caixa a zero) ou a deixa para a tarefa `account-closeout` entre o fechamento e a liquidação do IPO.
 * Aqui entram só a confirmação pelo apelido, a recusa da própria conta e o registro, gravado na mesma transação.
 */
@Injectable()
export class AdminDeleteService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly deletion: AccountDeletionService,
    private readonly log: AdminLogService,
    private readonly config: AccountsConfig,
  ) {}

  async delete(adminId: string, targetId: string, body: DeletePlayerBody): Promise<DeletePlayerResponse> {
    if (adminId === targetId) throw new DomainError("cannot_target_self", 409, ADMIN_ERROR_MESSAGES.cannot_target_self);
    const [user] = await this.db.select({ status: users.status }).from(users).where(eq(users.id, targetId));
    if (!user || user.status === "deleted") throw new DomainError("player_not_found", 404, ADMIN_ERROR_MESSAGES.player_not_found);
    return this.deletion.deleteAccount(targetId, {
      validate: (_tx, locked) => {
        if (locked.nickname !== body.confirmNickname) {
          throw new DomainError("nickname_mismatch", 422, ADMIN_ERROR_MESSAGES.nickname_mismatch);
        }
      },
      record: async (tx, { user: locked, walletCloseout }) => {
        await this.log.record(tx, {
          actorId: adminId,
          action: "player.delete",
          targetType: "player",
          targetId,
          reason: body.reason,
          // o e-mail nunca entra no registro: só o embaralhado
          before: { nickname: locked.nickname, emailFingerprint: locked.email ? emailFingerprint(this.config.adminLogEmailKey, locked.email) : null },
          after: { walletCloseout },
        });
      },
    });
  }
}
