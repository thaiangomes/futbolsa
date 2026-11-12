/**
 * Dados de demonstração da carteira e dos gráficos (T18 do Plano da carteira e gráficos): monta no banco do
 * `DATABASE_URL` o jogador `anagol` dos Protótipos, em 2027-06-13 às 16h40, com patrimônio de R$ 117.210,00
 * (caixa R$ 21.340,00 + ações R$ 95.380,00 + a receber R$ 490,00), negócios, candles, jogos, um dividendo aguardando
 * aprovação, o patrimônio diário e a foto de maio. Só para um banco de DESENVOLVIMENTO vazio (recusa se já há temporada).
 *
 *   npm run db:migrate && node --env-file-if-exists=../../.env --import tsx scripts/demo-carteira.ts   (dentro de apps/api)
 *
 * O login do site é o Supabase hospedado: para ver as telas entre com o e-mail `anagol@exemplo.com` cadastrado lá e ligue-o
 * à conta `anagol` (ou use a conta de teste). Sem isso, o gráfico público do clube e o perfil público já mostram os dados.
 */
import { sql } from "drizzle-orm";
import { connect, withTransaction } from "../src/infra/db/index.js";
import { lockWallets } from "../src/infra/db/index.js";
import { clubs, matches, payoutEvents, payoutHoldings, portfolioSnapshots, seasonClubs, seasons, trades, users, orders } from "../src/infra/db/schema/index.js";
import { seed } from "../src/infra/db/seed.js";
import { Clock } from "../src/infra/clock/index.js";
import { EquityDailyService } from "../src/modules/portfolio/daily/equity-daily.service.js";
import { openWallet, post } from "../src/modules/portfolio/ledger/index.js";
import { recordTrade } from "../src/modules/portfolio/candles/record-trade.js";
import { eq } from "drizzle-orm";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL vazio: preencha o .env (veja o .env.example).");
  process.exit(1);
}
const conn = connect(url, 4);
const db = conn.db;
const at = (iso: string) => new Date(iso);
const NOW = at("2027-06-13T19:40:00Z");

try {
  const existing = await db.select({ id: seasons.id }).from(seasons).limit(1);
  if (existing.length > 0) throw new Error("o banco já tem temporada: rode só num banco de desenvolvimento vazio");
  await seed(db, 2027);
  const [season] = await db.select().from(seasons);
  const seasonId = season!.id;
  const byTicker = new Map((await db.select({ id: clubs.id, ticker: clubs.ticker }).from(clubs)).map((c) => [c.ticker!, c.id]));
  const FLA = byTicker.get("FLA3")!;
  const PAL = byTicker.get("PAL3")!;
  const BOT = byTicker.get("BOT3") ?? byTicker.get("SPT3")!;
  for (const [ticker, id] of [["FLA3", FLA], ["PAL3", PAL], ["SPT3", BOT]] as const) {
    void ticker;
    await db.insert(seasonClubs).values({ seasonId, clubId: id, division: "A", totalShares: 3000, ipoPrice: 4000, lastPrice: 4000 });
  }
  await db.update(seasons).set({ status: "trading", tradingOpensAt: at("2027-04-05T13:00:00Z"), ipoClosesAt: at("2027-04-04T20:00:00Z") }).where(eq(seasons.id, seasonId));

  const [user] = await db.insert(users).values({ email: "anagol@exemplo.com", nickname: "anagol" }).returning({ id: users.id });
  const [rival] = await db.insert(users).values({ email: "bruno@exemplo.com", nickname: "bruno" }).returning({ id: users.id });
  const [third] = await db.insert(users).values({ email: "carla@exemplo.com", nickname: "carla" }).returning({ id: users.id });
  const wallets = await withTransaction(db, async (tx) => {
    const ana = await openWallet(tx, { seasonId, owner: { type: "user", userId: user!.id }, at: at("2027-04-01T13:00:00Z"), entryMode: "ipo", initialCash: 10_000_000 });
    const bruno = await openWallet(tx, { seasonId, owner: { type: "user", userId: rival!.id }, at: at("2027-04-01T13:00:00Z"), entryMode: "ipo", initialCash: 10_000_000 });
    const carla = await openWallet(tx, { seasonId, owner: { type: "user", userId: third!.id }, at: at("2027-04-01T13:00:00Z"), entryMode: "ipo", initialCash: 10_000_000 });
    return { ana: ana.id, bruno: bruno.id, carla: carla.id };
  });

  /** Um negócio entre duas carteiras: grava o negócio, os dois lados do extrato e os candles. */
  async function trade(when: string, clubId: number, buyer: number, seller: number, quantity: number, price: number) {
    await withTransaction(db, async (tx) => {
      await lockWallets(tx, [buyer, seller]);
      const base = { seasonId, clubId, type: "limit", quantity, filled: quantity, limitPrice: price, status: "filled", createdAt: at(when), updatedAt: at(when) };
      const [b] = await tx.db.insert(orders).values({ ...base, walletId: buyer, side: "buy" }).returning({ id: orders.id });
      const [s] = await tx.db.insert(orders).values({ ...base, walletId: seller, side: "sell" }).returning({ id: orders.id });
      const [t] = await tx.db.insert(trades).values({ seasonId, clubId, at: at(when), price, quantity, buyOrderId: b!.id, sellOrderId: s!.id, buyerWalletId: buyer, sellerWalletId: seller, priceBefore: price, inAuction: false }).returning({ id: trades.id });
      const ref = { type: "trade", id: t!.id };
      await post(tx, { walletId: buyer, at: at(when), kind: "trade", clubId, sharesDelta: quantity, cashDelta: -quantity * price, price, costBasis: "purchase", ref });
      await post(tx, { walletId: seller, at: at(when), kind: "trade", clubId, sharesDelta: -quantity, cashDelta: quantity * price, price, costBasis: "sale", ref });
      await recordTrade(tx, { clubId, at: at(when), price, quantity });
    });
    await db.update(seasonClubs).set({ lastPrice: price, lastTradeAt: at(when) }).where(sql`${seasonClubs.seasonId} = ${seasonId} and ${seasonClubs.clubId} = ${clubId}`);
  }

  // Bruno precisa ter as ações para vender: recebe do IPO
  await withTransaction(db, async (tx) => {
    await lockWallets(tx, [wallets.bruno]);
    await post(tx, { walletId: wallets.bruno, at: at("2027-04-04T20:30:00Z"), kind: "ipo_settle", clubId: FLA, sharesDelta: 800, cashDelta: -800 * 4000, price: 4000, costBasis: "purchase" });
    await post(tx, { walletId: wallets.bruno, at: at("2027-04-04T20:30:00Z"), kind: "ipo_settle", clubId: PAL, sharesDelta: 700, cashDelta: -700 * 4000, price: 4000, costBasis: "purchase" });
  });
  // Ana: 1.200 FLA3 do IPO a R$ 40,00 (liquidadas antes da abertura: aparecem "na abertura") e 600 PAL3 em dois lotes
  await withTransaction(db, async (tx) => {
    await lockWallets(tx, [wallets.ana]);
    await post(tx, { walletId: wallets.ana, at: at("2027-04-04T20:30:00Z"), kind: "ipo_settle", clubId: FLA, sharesDelta: 1200, cashDelta: -4_800_000, price: 4000, costBasis: "purchase" });
  });
  await trade("2027-04-20T13:10:00Z", PAL, wallets.ana, wallets.bruno, 400, 6000);
  await trade("2027-05-10T14:20:00Z", PAL, wallets.ana, wallets.bruno, 200, 8330);
  await trade("2027-06-02T13:05:00Z", FLA, wallets.bruno, wallets.ana, 200, 5000);
  // a cotação anda com negócios de Bruno e Carla (o último de cada clube é o preço exibido)
  await trade("2027-06-10T13:30:00Z", FLA, wallets.carla, wallets.bruno, 50, 5200);
  await trade("2027-06-12T15:00:00Z", PAL, wallets.carla, wallets.bruno, 10, 7030);
  await trade("2027-06-13T16:20:00Z", FLA, wallets.carla, wallets.bruno, 10, 5300);
  await trade("2027-06-13T18:55:00Z", FLA, wallets.bruno, wallets.carla, 10, 5320);

  // jogos: um terminado (V), um em andamento (FLA3 × BOT3) e um adiado (fica de fora)
  await db.insert(matches).values([
    { seasonId, competition: "brasileirao-a", round: 5, homeClubId: FLA, awayClubId: PAL, kickoff: at("2027-05-10T21:00:00Z"), status: "finished", homeGoals: 2, awayGoals: 1, finishedAt: at("2027-05-10T23:00:00Z") },
    { seasonId, competition: "brasileirao-a", round: 12, homeClubId: FLA, awayClubId: BOT, kickoff: at("2027-06-13T18:30:00Z"), status: "scheduled" },
    { seasonId, competition: "brasileirao-a", round: 11, homeClubId: PAL, awayClubId: FLA, kickoff: at("2027-06-06T21:00:00Z"), status: "postponed" },
  ]);
  // R$ 0,49 por ação em 1.000 FLA3: R$ 490,00 a receber (evento aguardando aprovação)
  const [event] = await db
    .insert(payoutEvents)
    .values({ seasonId, clubId: FLA, eventKey: "pts-12", kind: "points", reason: "49 centavos por ação, rodada 12", perShare: 49, closedAt: at("2027-06-13T12:00:00Z"), status: "pending", createdAt: at("2027-06-13T12:00:00Z") })
    .returning({ id: payoutEvents.id });
  await db.insert(payoutHoldings).values({ eventId: event!.id, walletId: wallets.ana, shares: 1000 });
  await db.insert(portfolioSnapshots).values({ walletId: wallets.ana, month: "2027-05", slices: { FLA3: 450, PAL3: 320, cash: 230 }, takenAt: at("2027-06-01T02:59:00Z") });

  const clock = { now: () => NOW } as Clock;
  const report = await new EquityDailyService(db, clock).runOnce(NOW);
  console.log(`pronto: ${report.written} pontos de patrimônio diário gravados.`);
  console.log("Jogador: anagol (anagol@exemplo.com). Esperado em 2027-06-13 16h40: patrimônio R$ 117.210,00 = caixa R$ 21.340,00 + ações R$ 95.380,00 + a receber R$ 490,00.");
} finally {
  await conn.close();
}
