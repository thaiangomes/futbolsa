import { sql } from "drizzle-orm";
import type { Tx } from "../../infra/db/transaction.js";

/** Quem pode aparecer num ranking, com o que a linha precisa mostrar. */
export interface Participant {
  walletId: number;
  isBot: boolean;
  userId: string | null;
  botId: number | null;
  enteredAt: Date;
}

/** O rótulo do perfil de um bot, para marcar a linha (nunca o apelido de uma conta). */
export function botLabelOf(profile: string): string {
  return `Bot ${profile}`;
}

/**
 * Quem aparece no ranking em `at` (T4 do Plano dos rankings): carteira de jogador com `entered_at ≤ at` e conta
 * `active` (bloqueado e excluído ficam de fora; o estado é o de **agora**, sem recálculo), carteira de bot só se a chave
 * "bots nos rankings" estiver ligada (todos os bots da temporada, ligados ou desligados: dúvida 1), nunca a tesouraria.
 * Em ordem de id da carteira (a ordem de entrada, que desempata a ordenação estável do motor). Só `SELECT`.
 */
export async function participants(tx: Pick<Tx, "db">, seasonId: number, at: Date, options: { botsIncluded: boolean }): Promise<Participant[]> {
  const result = await tx.db.execute(sql`
    select w.id, w.owner_type, w.user_id, w.bot_id, w.entered_at
    from futbolsa.wallets w
    left join futbolsa.users u on u.id = w.user_id
    where w.season_id = ${seasonId} and w.entered_at <= ${at.toISOString()}::timestamptz
      and ((w.owner_type = 'user' and u.status = 'active') or (w.owner_type = 'bot' and ${options.botsIncluded}))
    order by w.id`);
  return result.rows.map((r) => ({
    walletId: Number(r.id),
    isBot: r.owner_type === "bot",
    userId: r.user_id === null ? null : String(r.user_id),
    botId: r.bot_id === null ? null : Number(r.bot_id),
    enteredAt: new Date(r.entered_at as string),
  }));
}

/** Como a linha aparece: apelido atual, "conta excluída" (nulo) ou rótulo do bot. */
export interface Identity {
  displayName: string | null;
  isBot: boolean;
  botLabel: string | null;
  userId: string | null;
}

/** Apelido, situação e rótulo de uma lista de carteiras, numa consulta só (P4: a leitura das contas e dos bots). */
export async function identities(tx: Pick<Tx, "db">, walletIds: readonly number[]): Promise<Map<number, Identity>> {
  const out = new Map<number, Identity>();
  if (walletIds.length === 0) return out;
  const result = await tx.db.execute(sql`
    select w.id, w.owner_type, w.user_id, u.nickname, u.status, b.profile
    from futbolsa.wallets w
    left join futbolsa.users u on u.id = w.user_id
    left join futbolsa.bots b on b.id = w.bot_id
    where w.id in (${sql.join(walletIds.map((id) => sql`${id}`), sql`, `)})`);
  for (const r of result.rows) {
    const isBot = r.owner_type === "bot";
    out.set(Number(r.id), {
      isBot,
      displayName: isBot || r.status === "deleted" ? null : (r.nickname as string | null),
      botLabel: isBot ? botLabelOf(String(r.profile)) : null,
      userId: r.user_id === null ? null : String(r.user_id),
    });
  }
  return out;
}

/** As carteiras dadas, no formato de `Participant` (para o recálculo, que mantém o conjunto de quem estava no oficial). Em ordem de id. */
export async function participantsByIds(tx: Pick<Tx, "db">, walletIds: readonly number[]): Promise<Participant[]> {
  if (walletIds.length === 0) return [];
  const result = await tx.db.execute(sql`
    select w.id, w.owner_type, w.user_id, w.bot_id, w.entered_at
    from futbolsa.wallets w
    where w.id in (${sql.join(walletIds.map((id) => sql`${id}`), sql`, `)})
    order by w.id`);
  return result.rows.map((r) => ({
    walletId: Number(r.id),
    isBot: r.owner_type === "bot",
    userId: r.user_id === null ? null : String(r.user_id),
    botId: r.bot_id === null ? null : Number(r.bot_id),
    enteredAt: new Date(r.entered_at as string),
  }));
}
