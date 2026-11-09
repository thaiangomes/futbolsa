import { and, eq, gt, lte, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { lockWallets } from "../../src/infra/db/locks.js";
import { bots, payoutEvents, payoutHoldings, positions, seasonClubs, users, walletEntries } from "../../src/infra/db/schema/index.js";
import { withTransaction } from "../../src/infra/db/transaction.js";
import { post, type Movement } from "../../src/modules/portfolio/ledger/index.js";
import {
  copyHoldings,
  HOLDINGS_BATCH,
  holdingsAt,
  holdingsMap,
  holdingsQuery,
  writeHoldings,
  type Holding,
} from "../../src/modules/admin/payouts/holdings.js";
import { assertLedgerConsistent, assertSharesConserved } from "../support/invariants.js";
import { useTestDatabase } from "../support/db.js";
import { createUser, listClubs, openPlayerWallets, openWallets, rng, seedSeason, T0 } from "../support/fixtures.js";

/** Um horário do dia 16/05/2027 (UTC). */
const H = (hour: number, minute = 0, second = 0) => new Date(Date.UTC(2027, 4, 16, hour, minute, second));
const CLOSE = H(20);
const TOTAL = 10_000;
const TICKERS = ["FLA3", "PAL3", "COR3", "SAO3", "GRE3", "BOT3", "INT3", "CRU3"];

describe("foto das posições (holdingsAt)", () => {
  const t = useTestDatabase(8);
  let seasonId: number;
  let clubIds: Map<string, number>;
  let treasury: number;

  beforeAll(async () => {
    ({ seasonId, clubIds } = await seedSeason(t.db));
    await listClubs(t.db, seasonId, clubIds, TICKERS, TOTAL);
    treasury = (await openWallets(t.db, seasonId, [{ type: "treasury" }]))[0]!;
    // a tesouraria começa com todas as ações de cada clube (o IPO não importa aqui)
    await withTransaction(t.db, async (tx) => {
      await lockWallets(tx, [treasury!]);
      for (const ticker of TICKERS) {
        await post(tx, {
          walletId: treasury!,
          at: T0,
          kind: "adjustment",
          clubId: clubIds.get(ticker)!,
          sharesDelta: TOTAL,
          price: 4000,
          costBasis: "purchase",
          reason: "emissão das ações do clube",
        });
      }
    });
  });

  const club = (ticker: string) => clubIds.get(ticker)!;

  /** Trava as carteiras e aplica os movimentos numa transação (relógio explícito em cada movimento). */
  const apply = (walletIds: number[], movements: Movement[]) =>
    withTransaction(t.db, async (tx) => {
      await lockWallets(tx, walletIds);
      for (const m of movements) await post(tx, m);
    });

  /** Negócio: `seller` passa `shares` a `buyer` pelo preço, no instante `at`. */
  const trade = (seller: number, buyer: number, ticker: string, shares: number, at: Date, price = 4000) =>
    apply(
      [seller, buyer],
      [
        { walletId: seller, at, kind: "trade", clubId: club(ticker), sharesDelta: -shares, cashDelta: shares * price, price, costBasis: "sale" },
        { walletId: buyer, at, kind: "trade", clubId: club(ticker), sharesDelta: shares, cashDelta: -shares * price, price, costBasis: "purchase" },
      ],
    );

  const photo = async (ticker: string, at: Date) => Object.fromEntries((await holdingsAt(t.db, seasonId, club(ticker), at)).map((h) => [h.walletId, h.shares]));

  /** As ações da carteira no instante, somando o extrato inteiro até ele (a conta direta, para conferir). */
  const sharesByLedger = async (walletId: number, ticker: string, at: Date) => {
    const [row] = await t.db
      .select({ total: sql<string>`coalesce(sum(${walletEntries.sharesDelta}), 0)` })
      .from(walletEntries)
      .where(and(eq(walletEntries.walletId, walletId), eq(walletEntries.clubId, club(ticker)), lte(walletEntries.at, at)));
    return Number(row!.total);
  };

  it("admin 3: a foto do fechamento das 20h ignora a venda das 21h", async () => {
    const [ana, bruno] = await openPlayerWallets(t.db, seasonId, 2);
    await trade(treasury!, ana!, "FLA3", 1_000, H(19));
    await trade(ana!, bruno!, "FLA3", 500, H(21));
    const at20 = await photo("FLA3", CLOSE);
    expect(at20[ana!]).toBe(1_000);
    expect(at20[bruno!]).toBeUndefined();
    expect(await photo("FLA3", H(21))).toMatchObject({ [ana!]: 500, [bruno!]: 500 });
  });

  it("admin 4: ações presas em ordem de venda entram na foto", async () => {
    const [ana] = await openPlayerWallets(t.db, seasonId, 1);
    await trade(treasury!, ana!, "PAL3", 1_000, H(18));
    // ordem de venda de 400 aberta às 19h, executada só às 21h
    await apply([ana!], [{ walletId: ana!, at: H(19), kind: "order_reserve", clubId: club("PAL3"), reservedSharesDelta: 400, openOrdersDelta: 1 }]);
    expect(await photo("PAL3", CLOSE)).toEqual({ [ana!]: 1_000 });
    await apply(
      [ana!, treasury!],
      [
        { walletId: ana!, at: H(21), kind: "trade", clubId: club("PAL3"), sharesDelta: -400, reservedSharesDelta: -400, cashDelta: 400 * 4100, price: 4100, costBasis: "sale", openOrdersDelta: -1 },
        { walletId: treasury!, at: H(21), kind: "trade", clubId: club("PAL3"), sharesDelta: 400, cashDelta: -400 * 4100, price: 4100, costBasis: "purchase" },
      ],
    );
    expect(await photo("PAL3", CLOSE)).toEqual({ [ana!]: 1_000 });
    expect(await photo("PAL3", H(22))).toEqual({ [ana!]: 600 });
  });

  it("negócio exatamente no instante do fechamento conta como antes do fechamento", async () => {
    const [ana, bruno] = await openPlayerWallets(t.db, seasonId, 2);
    await trade(treasury!, ana!, "COR3", 1_000, H(19));
    await trade(ana!, bruno!, "COR3", 300, CLOSE);
    // um milissegundo depois do fechamento já fica fora
    await trade(ana!, bruno!, "COR3", 200, new Date(CLOSE.getTime() + 1));
    expect(await photo("COR3", CLOSE)).toEqual({ [ana!]: 700, [bruno!]: 300 });
    expect(await photo("COR3", new Date(CLOSE.getTime() - 1))).toEqual({ [ana!]: 1_000 });
  });

  it("a tesouraria não aparece; carteira zerada antes do fechamento não aparece; quem vendeu tudo depois aparece", async () => {
    const [zerou, vendeuDepois, comprouDepois] = await openPlayerWallets(t.db, seasonId, 3);
    await trade(treasury!, zerou!, "SAO3", 250, H(10));
    await trade(zerou!, treasury!, "SAO3", 250, H(15));
    await trade(treasury!, vendeuDepois!, "SAO3", 800, H(12));
    await trade(vendeuDepois!, comprouDepois!, "SAO3", 800, H(23));
    // hoje: a que vendeu tudo tem a linha em positions com 0 ações; só o extrato diz que tinha 800 às 20h
    const [now] = await t.db
      .select()
      .from(positions)
      .where(and(eq(positions.walletId, vendeuDepois!), eq(positions.clubId, club("SAO3"))));
    expect(now).toMatchObject({ shares: 0 });
    const at20 = await photo("SAO3", CLOSE);
    expect(at20).toEqual({ [vendeuDepois!]: 800 });
    expect(at20[treasury!]).toBeUndefined();
    expect(Object.keys(await photo("SAO3", H(23, 30)))).toEqual([String(comprouDepois!)]);
  });

  it("carteira que comprou e vendeu tudo depois do fechamento não aparece", async () => {
    const [w] = await openPlayerWallets(t.db, seasonId, 1);
    await trade(treasury!, w!, "INT3", 100, H(21));
    await trade(w!, treasury!, "INT3", 100, H(22));
    expect(await photo("INT3", CLOSE)).toEqual({});
  });

  it("uma linha com horário depois do fechamento (a anulação, acréscimo de 2026-11-07) não muda a foto do fechamento", async () => {
    const [ana, bruno] = await openPlayerWallets(t.db, seasonId, 2);
    await trade(treasury!, ana!, "GRE3", 1_000, H(18));
    await trade(ana!, bruno!, "GRE3", 300, H(19, 30));
    const before = await photo("GRE3", CLOSE);
    expect(before).toEqual({ [ana!]: 700, [bruno!]: 300 });
    // a anulação por trapaça desfaz o negócio das 19h30 às 22h: as linhas entram com o horário da anulação
    // (o tipo `trade_annulled` ainda não existe no CHECK; `adjustment` faz o mesmo papel aqui)
    await apply(
      [ana!, bruno!],
      [
        { walletId: bruno!, at: H(22), kind: "adjustment", clubId: club("GRE3"), sharesDelta: -300, cashDelta: 300 * 4000, costBasis: "debit", reason: "negócio anulado por trapaça" },
        { walletId: ana!, at: H(22), kind: "adjustment", clubId: club("GRE3"), sharesDelta: 300, cashDelta: -300 * 4000, price: 4000, costBasis: "purchase", reason: "negócio anulado por trapaça" },
      ],
    );
    expect(await photo("GRE3", CLOSE)).toEqual(before);
    expect(await photo("GRE3", H(22))).toEqual({ [ana!]: 1_000 });
  });

  it("bots, jogador bloqueado e conta excluída aparecem na foto", async () => {
    const [bot] = await t.db.insert(bots).values({ profile: "dividendos", active: true }).returning();
    const blockedUser = await createUser(t.db);
    const deletedUser = await createUser(t.db);
    const [botWallet, blocked, deleted] = await openWallets(t.db, seasonId, [
      { type: "bot", botId: bot!.id },
      { type: "user", userId: blockedUser },
      { type: "user", userId: deletedUser },
    ]);
    await trade(treasury!, botWallet!, "BOT3", 200, H(17));
    await trade(treasury!, blocked!, "BOT3", 150, H(17));
    await trade(treasury!, deleted!, "BOT3", 300, H(17));
    await t.db.update(users).set({ status: "blocked", blockedReason: "trapaça" }).where(eq(users.id, blockedUser));
    // a exclusão da conta às 22h zera a carteira (as ações vão à tesouraria)
    await apply(
      [deleted!, treasury!],
      [
        { walletId: deleted!, at: H(22), kind: "account_deleted", clubId: club("BOT3"), sharesDelta: -300, costBasis: "debit" },
        { walletId: treasury!, at: H(22), kind: "account_deleted", clubId: club("BOT3"), sharesDelta: 300, price: 4000, costBasis: "purchase" },
      ],
    );
    await t.db.update(users).set({ status: "deleted", email: null, nickname: null, deletedAt: H(22) }).where(eq(users.id, deletedUser));
    expect(await photo("BOT3", CLOSE)).toEqual({ [botWallet!]: 200, [blocked!]: 150, [deleted!]: 300 });
    expect(await photo("BOT3", H(23))).toEqual({ [botWallet!]: 200, [blocked!]: 150 });
  });

  it("invariante: foto + ações da tesouraria no instante = ações do clube, e cada carteira bate com o extrato até o instante", async () => {
    const players = await openPlayerWallets(t.db, seasonId, 6);
    const all = [treasury!, ...players];
    // caixa para a tesouraria também comprar de volta
    await apply([treasury!], [{ walletId: treasury!, at: H(11), kind: "adjustment", cashDelta: 10_000_000, reason: "caixa do teste" }]);
    const random = rng(20271116);
    const held = new Map(all.map((w) => [w, w === treasury ? TOTAL : 0]));
    // 80 negócios sorteados entre 12h e 24h, em ordem de horário (alguns no mesmo instante)
    const times = Array.from({ length: 80 }, () => H(12).getTime() + Math.floor(random() * 12 * 60) * 60_000).sort((a, b) => a - b);
    for (const time of times) {
      const sellers = all.filter((w) => held.get(w)! > 0);
      const seller = sellers[Math.floor(random() * sellers.length)]!;
      const buyers = all.filter((w) => w !== seller);
      const buyer = buyers[Math.floor(random() * buyers.length)]!;
      const shares = 1 + Math.floor(random() * held.get(seller)!);
      await trade(seller, buyer, "CRU3", shares, new Date(time), 100);
      held.set(seller, held.get(seller)! - shares);
      held.set(buyer, held.get(buyer)! + shares);
    }
    await assertLedgerConsistent(t.db, seasonId);
    await assertSharesConserved(t.db, seasonId);
    const [{ total }] = (await t.db.select({ total: seasonClubs.totalShares }).from(seasonClubs).where(and(eq(seasonClubs.seasonId, seasonId), eq(seasonClubs.clubId, club("CRU3"))))) as [{ total: number }];
    for (const at of [H(11), H(14), H(16, 30), CLOSE, H(22, 15), H(23, 59, 59)]) {
      const shot = await holdingsAt(t.db, seasonId, club("CRU3"), at);
      expect(shot.every((h) => h.shares > 0)).toBe(true);
      const sum = shot.reduce((s, h) => s + h.shares, 0);
      const treasuryAt = await sharesByLedger(treasury!, "CRU3", at);
      expect(sum + treasuryAt).toBe(total);
      for (const w of players) {
        expect(shot.find((h) => h.walletId === w)?.shares ?? 0).toBe(await sharesByLedger(w, "CRU3", at));
      }
    }
  });

  it("a foto vem em ordem de carteira e vira o mapa do settle com o id em texto", async () => {
    const shot = await holdingsAt(t.db, seasonId, club("BOT3"), CLOSE);
    expect(shot.map((h) => h.walletId)).toEqual([...shot.map((h) => h.walletId)].sort((a, b) => a - b));
    const map = holdingsMap(shot);
    expect([...map.keys()]).toEqual(shot.map((h) => String(h.walletId)));
    expect([...map.values()]).toEqual(shot.map((h) => h.shares));
  });

  it("aceita a transação ou o banco como executor, com o mesmo resultado", async () => {
    const direct = await holdingsAt(t.db, seasonId, club("COR3"), CLOSE);
    const inTx = await withTransaction(t.db, (tx) => holdingsAt(tx, seasonId, club("COR3"), CLOSE));
    const inDrizzleTx = await withTransaction(t.db, (tx) => holdingsAt(tx.db, seasonId, club("COR3"), CLOSE));
    expect(inTx).toEqual(direct);
    expect(inDrizzleTx).toEqual(direct);
  });

  it("a consulta lê o extrato pelo índice (wallet_id, club_id, at), só depois do fechamento", async () => {
    const plan = await t.db.transaction(async (dtx) => {
      // a tabela de teste é pequena: sem isto o Postgres prefere ler tudo em sequência
      await dtx.execute(sql`analyze futbolsa.wallet_entries`);
      await dtx.execute(sql`set local enable_seqscan = off`);
      const result = await dtx.execute(sql`explain ${holdingsQuery(seasonId, club("FLA3"), CLOSE)}`);
      return result.rows.map((r) => String(Object.values(r)[0])).join("\n");
    });
    expect(plan).toContain("wallet_entries_wallet_club_at_idx");
  });

  describe("gravar a foto (payout_holdings)", () => {
    const newEvent = async (key: string) => {
      const [event] = await t.db
        .insert(payoutEvents)
        .values({ seasonId, clubId: club("FLA3"), eventKey: key, kind: "points", reason: "3 pontos, rodada 1", competition: "brasileirao-a", round: 1, perShare: 30, closedAt: CLOSE, createdAt: H(20, 5) })
        .returning();
      return event!.id;
    };
    const stored = (eventId: number) =>
      t.db.select({ walletId: payoutHoldings.walletId, shares: payoutHoldings.shares }).from(payoutHoldings).where(eq(payoutHoldings.eventId, eventId)).orderBy(payoutHoldings.walletId);

    it("grava a foto do fechamento e a copia para a versão nova", async () => {
      const event = await newEvent("points|brasileirao-a|1|FLA3");
      const shot = await holdingsAt(t.db, seasonId, club("FLA3"), CLOSE);
      expect(shot.length).toBeGreaterThan(0);
      expect(await withTransaction(t.db, (tx) => writeHoldings(tx, event, shot))).toBe(shot.length);
      expect(await stored(event)).toEqual(shot);
      const next = await newEvent("points|brasileirao-a|1|FLA3 v2");
      expect(await withTransaction(t.db, (tx) => copyHoldings(tx, event, next))).toBe(shot.length);
      expect(await stored(next)).toEqual(shot);
    });

    it("lista vazia não grava nada nem quebra; ações zeradas ficam fora", async () => {
      const event = await newEvent("points|brasileirao-a|2|FLA3");
      expect(await withTransaction(t.db, (tx) => writeHoldings(tx, event, []))).toBe(0);
      const [w] = await openPlayerWallets(t.db, seasonId, 1);
      expect(await withTransaction(t.db, (tx) => writeHoldings(tx, event, [{ walletId: w!, shares: 0 }]))).toBe(0);
      expect(await stored(event)).toEqual([]);
      const copyTo = await newEvent("points|brasileirao-a|2|FLA3 v2");
      expect(await withTransaction(t.db, (tx) => copyHoldings(tx, event, copyTo))).toBe(0);
    });

    it(`grava em lotes de ${HOLDINGS_BATCH} linhas uma foto com milhares de carteiras`, async () => {
      const count = HOLDINGS_BATCH * 2 + 345;
      // carteiras em massa, direto no banco (a foto gravada não confere as posições)
      const created = await t.db.execute(sql`
        with u as (
          insert into futbolsa.users (email, nickname)
          select 'lote' || g || '@exemplo.com', 'lote_' || g from generate_series(1, ${count}) g
          returning id)
        insert into futbolsa.wallets (season_id, owner_type, user_id, entered_at)
        select ${seasonId}, 'user', id, ${T0.toISOString()}::timestamptz from u
        returning id`);
      const ids = created.rows.map((r) => Number(r.id)).sort((a, b) => a - b);
      const shot: Holding[] = ids.map((walletId, i) => ({ walletId, shares: 1 + (i % 7) }));
      const event = await newEvent("points|brasileirao-a|3|FLA3");
      expect(await withTransaction(t.db, (tx) => writeHoldings(tx, event, shot))).toBe(count);
      expect(await stored(event)).toEqual(shot);
      const [{ n }] = (await t.db.select({ n: sql<number>`count(*)::int` }).from(payoutHoldings).where(and(eq(payoutHoldings.eventId, event), gt(payoutHoldings.shares, 0)))) as [{ n: number }];
      expect(n).toBe(count);
    });
  });
});
