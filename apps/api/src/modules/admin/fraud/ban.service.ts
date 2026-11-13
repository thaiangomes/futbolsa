import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { FRAUD_ERROR_MESSAGES, type BanFraudBody, type BanFraudResponse } from "@futbolsa/contracts";
import { Clock } from "../../../infra/clock/index.js";
import { DB, type Database, type Tx } from "../../../infra/db/index.js";
import { fraudCases, fraudWarnings } from "../../../infra/db/schema/index.js";
import { DomainError } from "../../../infra/http/index.js";
import { NoticeMailJob } from "../../../infra/jobs/notice-mail.js";
import { NoticesService } from "../../accounts/notices.service.js";
import { AdminLogService } from "../log/index.js";
import { BlockService } from "../players/block.service.js";

/** O prefixo do `blocked_reason` do banimento: a tela e o registro sabem que o bloqueio veio da trapaça. */
export const FRAUD_BLOCK_PREFIX = "trapaça";

const notFound = () => new DomainError("case_not_found", 404, FRAUD_ERROR_MESSAGES.case_not_found);
const notOffered = () => new DomainError("ban_not_offered", 409, FRAUD_ERROR_MESSAGES.ban_not_offered);

interface WarningRef {
  id: number;
  caseId: number;
  at: string;
}

/**
 * Banir na reincidência (Admin, critério 45; T27 do Plano do admin de jogadores e bots, "Advertência e banimento").
 *
 * Só vale para conta de jogador do caso confirmado que já tinha advertência de caso anterior na mesma temporada (o
 * mesmo critério do `banOffer` da confirmação); fora disso, `ban_not_offered`. O banimento é o bloqueio da T3
 * (`BlockService.block`, que cancela as ordens e a oferta do IPO), com `blocked_reason` começando por "trapaça", e,
 * dentro da mesma transação e depois da trava da linha do usuário (a mesma que a confirmação pega, então a leitura das
 * advertências não corre com outra confirmação), o aviso `fraud_ban` e o registro `fraud.ban` com o caso, o hash da
 * foto, o motivo e as advertências (ids e datas, nunca e-mail nem apelido). O e-mail é acordado depois do `COMMIT`.
 * Desfazer é o desbloqueio da T3; a advertência fica.
 */
@Injectable()
export class FraudBanService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly clock: Clock,
    private readonly blocks: BlockService,
    private readonly notices: NoticesService,
    private readonly log: AdminLogService,
    private readonly mail: NoticeMailJob,
  ) {}

  async ban(adminId: string, caseId: number, body: BanFraudBody): Promise<BanFraudResponse> {
    const now = this.clock.now();
    const [exists] = await this.db.select({ id: fraudCases.id }).from(fraudCases).where(eq(fraudCases.id, caseId));
    if (!exists) throw notFound();
    let reportHash: string | null = null;
    let warnings: WarningRef[] = [];
    await this.blocks.block(adminId, body.userId, `${FRAUD_BLOCK_PREFIX}: ${body.reason}`, {
      validate: async (tx) => {
        const checked = await this.offered(tx, caseId, body.userId);
        reportHash = checked.reportHash;
        warnings = checked.warnings;
      },
      record: async (tx, done) => {
        await this.notices.create(tx, { userId: body.userId, kind: "fraud_ban", body: { reason: body.reason, trades: [] }, at: now });
        await this.log.record(tx, {
          actorId: adminId,
          action: "fraud.ban",
          targetType: "player",
          targetId: body.userId,
          reason: body.reason,
          before: { status: done.user.status, blockedReason: done.user.blockedReason },
          after: {
            status: "blocked",
            blockedReason: done.blockedReason,
            caseId,
            reportHash,
            warnings,
            cancelledOrderIds: done.cancelledOrderIds,
            cancelledBidIds: done.cancelledBidIds,
          },
        });
        tx.afterCommit(() => this.mail.wake());
      },
    });
    return { userId: body.userId, status: "blocked" };
  }

  /**
   * O caso confirmado em que a conta foi advertida e as advertências dela na temporada do caso até esta, com pelo menos
   * uma anterior. Lido com a linha do usuário travada.
   */
  private async offered(tx: Tx, caseId: number, userId: string): Promise<{ reportHash: string | null; warnings: WarningRef[] }> {
    const [c] = await tx.db.select({ status: fraudCases.status, seasonId: fraudCases.seasonId, reportHash: fraudCases.reportHash }).from(fraudCases).where(eq(fraudCases.id, caseId));
    if (!c) throw notFound();
    if (c.status !== "confirmed") throw notOffered();
    const rows = await tx.db
      .select({ id: fraudWarnings.id, caseId: fraudWarnings.caseId, at: fraudWarnings.at })
      .from(fraudWarnings)
      .where(and(eq(fraudWarnings.userId, userId), eq(fraudWarnings.seasonId, c.seasonId)))
      .orderBy(asc(fraudWarnings.id));
    const mine = rows.findIndex((w) => Number(w.caseId) === caseId);
    // sem advertência neste caso (conta de fora, bot) ou esta foi a primeira
    if (mine <= 0) throw notOffered();
    return {
      reportHash: c.reportHash,
      warnings: rows.slice(0, mine + 1).map((w) => ({ id: Number(w.id), caseId: Number(w.caseId), at: w.at.toISOString() })),
    };
  }
}
