import { eq } from "drizzle-orm";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { expect } from "vitest";
import { fraudCaseDetailSchema } from "@futbolsa/contracts";
import type { Database } from "../../src/infra/db/client.js";
import { lockClubs, withTransaction } from "../../src/infra/db/index.js";
import { wallets } from "../../src/infra/db/schema/index.js";
import { setClubPrice } from "../../src/modules/market/index.js";
import { recordTrade } from "../../src/modules/portfolio/index.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { bearer } from "../support/auth.js";
import { INITIAL_CASH, openWallets } from "../support/fixtures.js";
import { insertTrade } from "../market/helpers.js";
import { applyMovements } from "../portfolio/support.js";

/** Ajudantes dos testes da decisão do caso de trapaça (T25 da F14). */

/** Os 20 clubes: cada cenário usa o seu, para os preços de um não mexerem nos do outro. */
export const ALL_TICKERS = ["FLA3", "FLU3", "VAS3", "BOT3", "COR3", "PAL3", "SAO3", "SAN3", "GRE3", "INT3", "CRU3", "CAM3", "BAH3", "FOR3", "CEA3", "SPT3", "JUV3", "VIT3", "MIR3", "RBB3"];

/** Um instante pelo relógio de Brasília. */
export const brt = (day: string, time = "11:00") => new Date(`${day}T${time}:00-03:00`);

export interface Player {
  account: TestAccount;
  wallet: number;
}

export async function newPlayer(db: Database, seasonId: number, o: { nickname?: string; role?: "admin" | "player"; cash?: number } = {}): Promise<Player> {
  const account = await createAccount(db, { ...(o.nickname ? { nickname: o.nickname } : {}), ...(o.role ? { role: o.role } : {}) });
  const [wallet] = await openWallets(db, seasonId, [{ type: "user", userId: account.id }], o.cash ?? INITIAL_CASH);
  return { account, wallet: wallet! };
}

/**
 * Um negócio entre duas carteiras como o motor de ordens o deixa, sem passar por ele: a linha em `trades` (com as
 * duas ordens executadas), as duas linhas `trade` do extrato, os candles e o preço exibido do clube.
 */
export async function pairTrade(
  db: Database,
  seasonId: number,
  clubId: number,
  ticker: string,
  t: { buyer: number; seller: number; at: Date; price: number; quantity?: number; priceBefore?: number },
): Promise<number> {
  const quantity = t.quantity ?? 1;
  const id = await insertTrade(db, { seasonId, clubId, at: t.at, price: t.price, quantity, buyerWalletId: t.buyer, sellerWalletId: t.seller, priceBefore: t.priceBefore ?? t.price });
  const ref = { type: "trade", id };
  await applyMovements(db, t.seller, t.at, { kind: "trade", clubId, sharesDelta: -quantity, cashDelta: quantity * t.price, price: t.price, costBasis: "sale", ref });
  await applyMovements(db, t.buyer, t.at, { kind: "trade", clubId, sharesDelta: quantity, cashDelta: -quantity * t.price, price: t.price, costBasis: "purchase", ref });
  await withTransaction(db, async (tx) => {
    await lockClubs(tx, seasonId, [ticker]);
    await recordTrade(tx, { clubId, at: t.at, price: t.price, quantity });
    await setClubPrice(tx, seasonId, clubId, t.price, t.at);
  });
  return id;
}

/** Abre o caso manual do par (como a auditoria faz) e devolve o id. */
export async function openCase(
  app: NestFastifyApplication,
  token: string,
  a: { userId: string } | { botId: number },
  b: { userId: string } | { botId: number },
  o: { ticker?: string; from?: string; to?: string } = {},
): Promise<number> {
  const res = await app.inject({
    method: "POST",
    url: "/admin/fraud/cases",
    headers: bearer(token),
    payload: { accountA: a, accountB: b, from: o.from ?? "2027-07-01T00:00:00Z", to: o.to ?? "2027-08-05T12:00:00Z", ...(o.ticker ? { ticker: o.ticker } : {}) },
  });
  expect(res.statusCode, res.body).toBe(201);
  return fraudCaseDetailSchema.parse(res.json()).id;
}

/** O id do bot dono da carteira. */
export async function botIdOf(db: Database, walletId: number): Promise<number> {
  const [w] = await db.select({ botId: wallets.botId }).from(wallets).where(eq(wallets.id, walletId));
  return w!.botId!;
}
