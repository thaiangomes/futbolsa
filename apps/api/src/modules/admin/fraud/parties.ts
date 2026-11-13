import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { FraudParty } from "@futbolsa/contracts";
import type { Database, DrizzleTx } from "../../../infra/db/index.js";
import { bots, fraudWarnings, users, wallets } from "../../../infra/db/schema/index.js";

type Db = Database | DrizzleTx;

/**
 * As contas de um caso a partir das carteiras, em lote: apelido e e-mail lidos na hora (o e-mail só existe aqui, no
 * `/admin`), "conta excluída" sem nenhum dado pessoal, bot marcado e as advertências da temporada. `exceptCaseId`
 * tira as do próprio caso, para um caso decidido mostrar as de antes dele. A casa nunca é parte de um caso.
 */
export async function fraudParties(db: Db, seasonId: number, walletIds: readonly number[], exceptCaseId?: number): Promise<Map<number, FraudParty>> {
  const out = new Map<number, FraudParty>();
  if (walletIds.length === 0) return out;
  const rows = await db
    .select({
      id: wallets.id,
      ownerType: wallets.ownerType,
      userId: wallets.userId,
      botId: wallets.botId,
      nickname: users.nickname,
      email: users.email,
      status: users.status,
    })
    .from(wallets)
    .leftJoin(users, eq(users.id, wallets.userId))
    .where(inArray(wallets.id, [...walletIds]));
  const botIds = rows.flatMap((r) => (r.botId === null ? [] : [r.botId]));
  const profiles = new Map<number, string>();
  if (botIds.length > 0) {
    for (const b of await db.select({ id: bots.id, profile: bots.profile }).from(bots).where(inArray(bots.id, botIds))) profiles.set(b.id, b.profile);
  }
  const userIds = rows.flatMap((r) => (r.userId === null ? [] : [r.userId]));
  const warnings = new Map<string, number>();
  if (userIds.length > 0) {
    const counted = await db
      .select({ userId: fraudWarnings.userId, n: sql<number>`count(*)::int` })
      .from(fraudWarnings)
      .where(and(eq(fraudWarnings.seasonId, seasonId), inArray(fraudWarnings.userId, userIds), exceptCaseId === undefined ? undefined : ne(fraudWarnings.caseId, exceptCaseId)))
      .groupBy(fraudWarnings.userId);
    for (const w of counted) warnings.set(w.userId, w.n);
  }
  for (const r of rows) {
    if (r.ownerType === "bot") {
      out.set(r.id, { walletId: r.id, kind: "bot", userId: null, label: `bot ${profiles.get(r.botId!)} #${r.botId}`, email: null, warnings: 0 });
    } else if (r.ownerType === "user" && r.userId && r.status !== "deleted" && r.nickname !== null) {
      out.set(r.id, { walletId: r.id, kind: "player", userId: r.userId, label: r.nickname, email: r.email ?? null, warnings: warnings.get(r.userId) ?? 0 });
    } else {
      // conta excluída: sem apelido, sem e-mail
      out.set(r.id, { walletId: r.id, kind: "deleted", userId: null, label: "conta excluída", email: null, warnings: 0 });
    }
  }
  return out;
}
