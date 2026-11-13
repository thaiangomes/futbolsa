import { eq } from "drizzle-orm";
import type { UserStatus } from "@futbolsa/contracts";
import type { Database } from "../../src/infra/db/client.js";
import { withTransaction } from "../../src/infra/db/index.js";
import { bots, seasons, users, wallets } from "../../src/infra/db/schema/index.js";
import { createAccount } from "../support/accounts.js";
import { openWallets } from "../support/fixtures.js";
import { applyMovements } from "../portfolio/support.js";

export { portfolioSeason, applyMovements, setPrice, ipoBuy, insertPayout, creditPayout } from "../portfolio/support.js";
export type { PortfolioSeason } from "../portfolio/support.js";

export const at = (iso: string) => new Date(iso);

/** O horário de Brasília (UTC−3) escrito como no dia a dia: `br("2027-06-30 23:59")`. */
export const br = (local: string) => new Date(`${local.replace(" ", "T")}${local.length === 16 ? ":00" : ""}-03:00`);

export const BASE = 10_000_000;

/** Um jogador com conta e carteira (entrou em `enteredAt`; o padrão é o início da temporada). */
export async function player(db: Database, seasonId: number, o: { enteredAt?: Date; status?: UserStatus; nickname?: string } = {}) {
  const account = await createAccount(db, { status: o.status, nickname: o.nickname });
  const [wallet] = await openWallets(db, seasonId, [{ type: "user", userId: account.id }]);
  if (o.enteredAt) await db.update(wallets).set({ enteredAt: o.enteredAt }).where(eq(wallets.id, wallet!));
  return { account, wallet: wallet! };
}

/** Um bot do perfil dado, com carteira. */
export async function bot(db: Database, seasonId: number, profile: string = "dividendos") {
  const [row] = await db.insert(bots).values({ profile, active: true }).returning({ id: bots.id });
  const [wallet] = await openWallets(db, seasonId, [{ type: "bot", botId: row!.id }]);
  return { botId: row!.id, wallet: wallet! };
}

/** Leva o caixa (e portanto o patrimônio, sem ações) da carteira ao valor dado, num lançamento em `when`. */
export async function setCash(db: Database, walletId: number, when: Date, target: number, clubId: number): Promise<void> {
  const [w] = await db.select({ cash: wallets.cash }).from(wallets).where(eq(wallets.id, walletId));
  const delta = target - w!.cash;
  if (delta === 0) return;
  await applyMovements(db, walletId, when, delta > 0 ? { kind: "adjustment", cashDelta: delta, reason: "ajuste de teste" } : { kind: "reversal", clubId, cashDelta: delta, reason: "estorno de teste" });
}

export async function setBotsInRankings(db: Database, seasonId: number, on: boolean) {
  await db.update(seasons).set({ botsInRankings: on }).where(eq(seasons.id, seasonId));
}

export const setStatus = (db: Database, userId: string, status: UserStatus) => db.update(users).set({ status }).where(eq(users.id, userId));

export const inTx = <T>(db: Database, fn: Parameters<typeof withTransaction<T>>[1]) => withTransaction(db, fn);
