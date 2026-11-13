import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, eq, isNull, lt, sql } from "drizzle-orm";
import { NOTICE_ERROR_MESSAGES, noticeBodySchema, type NoticeBody, type NoticeKind, type PendingNotice, type ReadNoticeResponse } from "@futbolsa/contracts";
import { formatBRL } from "@futbolsa/engine";
import { Clock } from "../../infra/clock/index.js";
import { DB, type Database, type Tx } from "../../infra/db/index.js";
import { DomainError } from "../../infra/http/index.js";
import { Mailer } from "../../infra/mail/index.js";
import { playerNotices, users } from "../../infra/db/schema/index.js";

/** Tentativas de e-mail por aviso: a quinta falha encerra (o aviso na entrada continua valendo). */
export const MAX_MAIL_ATTEMPTS = 5;
/** Quantos e-mails uma rodada da tarefa envia no máximo. */
const MAIL_BATCH = 50;

/**
 * Avisos ao jogador (T26 da F14; dono: `accounts`): a anulação de negócios por trapaça e o banimento. O aviso é gravado na
 * transação de quem decide (`create`), aparece em `GET /me` até o jogador confirmar (`markRead`) e vai por e-mail por
 * uma tarefa (`sendQueued`), nunca dentro da transação: falha de e-mail não desfaz nada. **Nunca cita a outra conta**
 * (proposta 22). Quem joga só lê os próprios avisos.
 */
@Injectable()
export class NoticesService {
  private readonly logger = new Logger("Avisos");

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly clock: Clock,
    private readonly mailer: Mailer,
  ) {}

  /** Grava o aviso na transação de quem decide. Valida o corpo: o que não cabe no contrato nem entra. */
  async create(tx: Tx, input: { userId: string; kind: NoticeKind; body: NoticeBody; at: Date }): Promise<number> {
    const body = noticeBodySchema.parse(input.body);
    const [row] = await tx.db
      .insert(playerNotices)
      .values({ userId: input.userId, kind: input.kind, body, createdAt: input.at })
      .returning({ id: playerNotices.id });
    return row!.id;
  }

  /** Os avisos que o jogador ainda não confirmou, do mais antigo para o mais novo. O bloqueado também vê. */
  async pending(userId: string): Promise<PendingNotice[]> {
    const rows = await this.db
      .select()
      .from(playerNotices)
      .where(and(eq(playerNotices.userId, userId), isNull(playerNotices.readAt)))
      .orderBy(asc(playerNotices.createdAt), asc(playerNotices.id));
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as NoticeKind,
      createdAt: r.createdAt.toISOString(),
      body: noticeBodySchema.parse(r.body),
    }));
  }

  /** Só o dono confirma; confirmar de novo devolve o horário da primeira vez. */
  async markRead(userId: string, noticeId: number): Promise<ReadNoticeResponse> {
    const now = this.clock.now();
    const [updated] = await this.db
      .update(playerNotices)
      .set({ readAt: sql`coalesce(${playerNotices.readAt}, ${now.toISOString()}::timestamptz)` })
      .where(and(eq(playerNotices.id, noticeId), eq(playerNotices.userId, userId)))
      .returning({ readAt: playerNotices.readAt });
    if (!updated) throw new DomainError("notice_not_found", 404, NOTICE_ERROR_MESSAGES.notice_not_found);
    return { readAt: updated.readAt!.toISOString() };
  }

  /**
   * Envia os e-mails da fila: avisos sem `email_sent_at`, de conta que ainda existe, com até 5 tentativas. O endereço é lido
   * na hora do envio (a conta excluída não tem mais e não recebe). Conta a tentativa antes de enviar e só marca o envio
   * depois do sucesso. Nunca lança por falha de e-mail. Devolve quantos saíram.
   */
  async sendQueued(): Promise<number> {
    const queued = await this.db
      .select({ id: playerNotices.id, kind: playerNotices.kind, body: playerNotices.body, nickname: users.nickname, email: users.email })
      .from(playerNotices)
      .innerJoin(users, eq(users.id, playerNotices.userId))
      .where(and(isNull(playerNotices.emailSentAt), lt(playerNotices.emailAttempts, MAX_MAIL_ATTEMPTS), eq(users.status, "active")))
      .orderBy(asc(playerNotices.id))
      .limit(MAIL_BATCH);
    let sent = 0;
    for (const n of queued) {
      if (!n.email) continue;
      const claimed = await this.db
        .update(playerNotices)
        .set({ emailAttempts: sql`${playerNotices.emailAttempts} + 1` })
        .where(and(eq(playerNotices.id, n.id), isNull(playerNotices.emailSentAt), lt(playerNotices.emailAttempts, MAX_MAIL_ATTEMPTS)))
        .returning({ id: playerNotices.id });
      if (claimed.length === 0) continue;
      try {
        const mail = noticeMail(n.kind as NoticeKind, noticeBodySchema.parse(n.body), n.nickname ?? "jogador");
        await this.mailer.send({ to: n.email, ...mail });
        await this.db.update(playerNotices).set({ emailSentAt: this.clock.now() }).where(eq(playerNotices.id, n.id));
        sent += 1;
      } catch (error) {
        // a mensagem do erro nunca leva senha nem endereço (smtp-client.ts); mesmo assim só o texto
        this.logger.warn(`e-mail do aviso ${n.id} não saiu, tenta de novo na próxima rodada: ${(error as Error).message}`);
      }
    }
    return sent;
  }
}

/** O assunto e o texto do e-mail de um aviso. */
export function noticeMail(kind: NoticeKind, body: NoticeBody, nickname: string): { subject: string; text: string } {
  const lines: string[] = [`Olá, ${nickname}.`, ""];
  if (kind === "fraud_ban") {
    lines.push("A sua conta no FutBolsa foi bloqueada por trapaça.", "", `Motivo: ${body.reason}`, "", "Se você acha que isto é um engano, responda ao admin do jogo.");
    return { subject: "FutBolsa: a sua conta foi bloqueada", text: lines.join("\n") };
  }
  lines.push("O admin do FutBolsa anulou negócios da sua conta por trapaça: negócios combinados para mexer no preço de um clube.", "");
  lines.push(`Motivo: ${body.reason}`, "", "Negócios anulados:");
  for (const t of body.trades) {
    lines.push(`- ${t.at} · ${t.ticker} · ${t.quantity} ações a ${formatBRL(t.price)} (${formatBRL(t.value)})`);
  }
  lines.push("", "Se você continuar trapaceando, a sua conta será banida.", "Ao entrar no jogo você verá este aviso e precisa confirmá-lo.");
  return { subject: "FutBolsa: negócios anulados na sua conta", text: lines.join("\n") };
}
