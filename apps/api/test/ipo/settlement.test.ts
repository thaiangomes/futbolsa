import "reflect-metadata";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixedClock } from "../../src/infra/clock/index.js";
import {
  ipoAllocations,
  ipoBids,
  ipoResults,
  positions,
  seasonClubs,
  seasons,
  users,
  walletEntries,
  wallets,
} from "../../src/infra/db/schema/index.js";
import { AccountDeletionService } from "../../src/modules/accounts/index.js";
import { IpoBidsService, IpoClosingService, type IpoSettleResult, IpoSettlementService } from "../../src/modules/ipo/index.js";
import { createAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { INITIAL_CASH, openWallets, seedSeason } from "../support/fixtures.js";
import { assertLedgerConsistent, assertSharesConserved, totalCash } from "../support/invariants.js";

const MINUTE = 60_000;
/** O período de ofertas da temporada de teste: abriu em 2027-03-28 às 16h e fecha em 2027-04-04 às 16h. */
const OPENS_AT = new Date("2027-03-28T19:00:00Z");
const CLOSES_AT = new Date("2027-04-04T19:00:00Z");
/** As ofertas são feitas a partir daqui, um minuto entre uma e outra (o desempate do rateio). */
const DURING = new Date("2027-03-30T15:00:00Z");
/** A passada da tarefa que liquida, um minuto depois do fechamento. */
const SETTLE_AT = new Date("2027-04-04T19:01:00Z");
const OFFER = 3000;
/** Lote do formador: 20% da oferta (2.000 pontos-base, o padrão da temporada). */
const LOT = 600;
/** A faixa do FLA3 do critério 5 (R$ 30,33 a R$ 70,77), gravada igual em todos os clubes do teste. */
const BAND = { bandCenter: 5055, bandFloor: 3033, bandCeiling: 7077 };
const FLOOR = BAND.bandFloor;

/**
 * Um clube por cenário, todos na mesma temporada e na mesma passada:
 * - FLA3: critérios 16, 21, 29 e Carteira 1 (1.500 até R$ 40, 1.000 até R$ 37, 2.000 até R$ 35);
 * - PAL3: critério 17 (empate no resto do rateio);
 * - VAS3: 18 (demanda abaixo da oferta no piso); BOT3: 19 (demanda exata); COR3: 20 (sem oferta);
 * - SAO3: 22 (oferta abaixo do corte);
 * - SAN3, GRE3 e INT3: as mesmas três ofertas; no GRE3 uma conta é excluída e no INT3 outra é bloqueada
 *   depois do fechamento, e o rateio tem de sair igual ao do SAN3 (proposta 8).
 */
const TICKERS = ["BOT3", "COR3", "FLA3", "GRE3", "INT3", "PAL3", "SAN3", "SAO3", "VAS3"];

describe("liquidação do IPO", () => {
  const database = useTestDatabase(10);
  const clock = new FixedClock(DURING);
  let app: NestFastifyApplication;
  let bids: IpoBidsService;
  let settlement: IpoSettlementService;
  let seasonId: number;
  let clubIds: Map<string, number>;
  let treasury: number;
  /** A carteira e a conta de cada jogador, pelo apelido. */
  const players = new Map<string, { userId: string; walletId: number }>();
  /** O dinheiro de todas as carteiras (jogadores e tesouraria) antes da liquidação. */
  let cashBefore = 0;
  let firstPass: IpoSettleResult;

  const club = (ticker: string) => clubIds.get(ticker)!;
  const wallet = (name: string) => players.get(name)!.walletId;

  async function player(name: string) {
    const account = await createAccount(database.db, { nickname: name });
    const [walletId] = await openWallets(database.db, seasonId, [{ type: "user", userId: account.id }]);
    players.set(name, { userId: account.id, walletId: walletId! });
  }

  /** Uma oferta pelo serviço das ofertas (A3), um minuto depois da anterior. */
  async function bid(name: string, ticker: string, quantity: number, maxPrice: number, expectValue: "new" | "existing" = "new") {
    clock.advance(MINUTE);
    await bids.place(wallet(name), ticker, { quantity, maxPrice, expect: expectValue });
  }

  const bidOf = async (name: string, ticker: string) =>
    (await database.db.select().from(ipoBids).where(and(eq(ipoBids.walletId, wallet(name)), eq(ipoBids.clubId, club(ticker)))))[0]!;
  const allocationOf = async (name: string, ticker: string) => {
    const b = await bidOf(name, ticker);
    return (await database.db.select().from(ipoAllocations).where(eq(ipoAllocations.bidId, b.id)))[0];
  };
  const walletRow = async (walletId: number) => (await database.db.select().from(wallets).where(eq(wallets.id, walletId)))[0]!;
  const positionOf = async (walletId: number, ticker: string) =>
    (await database.db.select().from(positions).where(and(eq(positions.walletId, walletId), eq(positions.clubId, club(ticker)))))[0];
  const settleEntries = (walletId: number, ticker?: string) =>
    database.db
      .select()
      .from(walletEntries)
      .where(
        and(
          eq(walletEntries.walletId, walletId),
          eq(walletEntries.kind, "ipo_settle"),
          ticker === undefined ? undefined : eq(walletEntries.clubId, club(ticker)),
        ),
      )
      .orderBy(asc(walletEntries.id));
  const resultOf = async (ticker: string) =>
    (await database.db.select().from(ipoResults).where(and(eq(ipoResults.seasonId, seasonId), eq(ipoResults.clubId, club(ticker)))))[0];
  const seasonClub = async (ticker: string) =>
    (await database.db.select().from(seasonClubs).where(and(eq(seasonClubs.seasonId, seasonId), eq(seasonClubs.clubId, club(ticker)))))[0]!;
  const sharesOf = async (name: string, ticker: string) => (await positionOf(wallet(name), ticker))?.shares ?? 0;

  /** Linha `ipo_settle` de um jogador: reserva solta, caixa pago, ações pelo corte e a referência da oferta. */
  async function expectSettleLine(name: string, ticker: string, o: { shares: number; price: number; reserved: number }) {
    const b = await bidOf(name, ticker);
    const paid = o.shares * o.price;
    const [line, ...rest] = await settleEntries(wallet(name), ticker);
    expect(rest).toHaveLength(0);
    expect(line).toMatchObject({
      at: SETTLE_AT,
      clubId: club(ticker),
      cashDelta: paid === 0 ? 0 : -paid,
      reservedCashDelta: -o.reserved,
      sharesDelta: o.shares,
      reservedSharesDelta: 0,
      price: o.shares > 0 ? o.price : null,
      refType: "ipo_bid",
      refId: String(b.id),
    });
    expect(await allocationOf(name, ticker)).toEqual({ bidId: b.id, shares: o.shares, paid, refunded: o.reserved - paid });
  }

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    bids = app.get(IpoBidsService);
    settlement = app.get(IpoSettlementService);
    ({ seasonId, clubIds } = await seedSeason(database.db, 2027));
    // O estado que a abertura (A2) deixa: faixas gravadas, a tesouraria aberta sem caixa e as ofertas abertas.
    await database.db.insert(seasonClubs).values(TICKERS.map((ticker) => ({ seasonId, clubId: club(ticker), division: "A", ...BAND })));
    await database.db
      .update(seasons)
      .set({ status: "ipo_open", offerSize: OFFER, ipoOpensAt: OPENS_AT, ipoClosesAt: CLOSES_AT, firstKickoff: new Date("2027-04-11T19:00:00Z") })
      .where(eq(seasons.id, seasonId));
    [treasury] = (await openWallets(database.db, seasonId, [{ type: "treasury" }])) as [number];

    for (const name of [
      "ana", "bruno", "carla", "xavi_um", "xavi_dois", "xavi_tres", "dora", "edu", "fabi", "gil", "hugo", "ivo",
      "san_um", "san_dois", "san_tres", "gre_um", "gre_dois", "gre_tres", "int_um", "int_dois", "int_tres",
    ]) {
      await player(name);
    }

    // FLA3 (16, 21, 29, Carteira 1).
    await bid("ana", "FLA3", 1500, 4000);
    await bid("bruno", "FLA3", 1000, 3700);
    await bid("carla", "FLA3", 2000, 3500);
    // PAL3 (17): xavi_um registra primeiro, mas altera por último; o resto do rateio empata com xavi_dois.
    await bid("xavi_um", "PAL3", 1000, 4000);
    await bid("xavi_dois", "PAL3", 1003, 4000);
    await bid("xavi_tres", "PAL3", 1744, 4000);
    await bid("xavi_um", "PAL3", 1003, 4000, "existing");
    // VAS3 (18), BOT3 (19), SAO3 (22); COR3 (20) fica sem oferta.
    await bid("dora", "VAS3", 1200, FLOOR);
    await bid("edu", "BOT3", 1000, 4000);
    await bid("fabi", "BOT3", 2000, 4000);
    await bid("gil", "SAO3", 1500, 4000);
    await bid("hugo", "SAO3", 1500, 4500);
    await bid("ivo", "SAO3", 500, 3100);
    // SAN3, GRE3 e INT3: as mesmas ofertas, na mesma ordem.
    for (const [quantity, maxPrice, suffix] of [[2000, 4000, "um"], [1500, 3800, "dois"], [1000, 3600, "tres"]] as const) {
      for (const ticker of ["SAN3", "GRE3", "INT3"]) await bid(`${ticker.slice(0, 3).toLowerCase()}_${suffix}`, ticker, quantity, maxPrice);
    }
  });
  afterAll(() => app?.close());

  it("fora de ipo_closed não faz nada: com as ofertas abertas a passada não liquida nenhum clube", async () => {
    expect(await settlement.settleDue(SETTLE_AT)).toEqual({ status: "idle" });
    expect(await database.db.select().from(ipoResults)).toHaveLength(0);
    expect(await database.db.select().from(ipoAllocations)).toHaveLength(0);
    expect(await database.db.select().from(walletEntries).where(eq(walletEntries.kind, "ipo_settle"))).toHaveLength(0);
    expect((await seasonClub("FLA3")).ipoPrice).toBeNull();
  });

  it("proposta 8: conta excluída e conta bloqueada depois do fechamento ficam com a oferta ativa e a reserva presa", async () => {
    expect(await app.get(IpoClosingService).closeIfDue(CLOSES_AT)).toMatchObject({ status: "closed" });
    clock.set(new Date(CLOSES_AT.getTime() + 30_000));

    const deleted = await app.get(AccountDeletionService).deleteAccount(players.get("gre_dois")!.userId);
    expect(deleted).toEqual({ walletCloseout: "after_ipo_settlement" });
    await database.db.update(users).set({ status: "blocked" }).where(eq(users.id, players.get("int_um")!.userId));

    expect(await bidOf("gre_dois", "GRE3")).toMatchObject({ status: "active", reserved: 1500 * 3800 });
    expect(await bidOf("int_um", "INT3")).toMatchObject({ status: "active", reserved: 2000 * 4000 });
    expect((await walletRow(wallet("gre_dois"))).reservedCash).toBe(1500 * 3800);
    expect((await walletRow(wallet("int_um"))).reservedCash).toBe(2000 * 4000);
  });

  it("uma passada liquida os 9 clubes, em ordem de ticker, e a temporada continua em ipo_closed", async () => {
    cashBefore = await totalCash(database.db, seasonId);
    firstPass = await settlement.settleDue(SETTLE_AT);
    expect(firstPass).toEqual({ status: "ran", seasonId, settled: TICKERS, skipped: [], failed: [], pending: 0 });
    expect((await database.db.select().from(seasons).where(eq(seasons.id, seasonId)))[0]!.status).toBe("ipo_closed");
    expect(await database.db.select().from(ipoResults).where(eq(ipoResults.seasonId, seasonId))).toHaveLength(TICKERS.length);
    // Toda oferta foi liquidada, inclusive as não atendidas; a reserva e o desempate da oferta ficam como estavam.
    const all = await database.db.select().from(ipoBids).where(eq(ipoBids.seasonId, seasonId));
    expect(all.length).toBe(21);
    for (const b of all) expect(b.status).toBe("settled");
    expect((await bidOf("xavi_um", "PAL3")).reserved).toBe(1003 * 4000);
  });

  it("ipo 16: corte R$ 35, fração 2/3, 1.000, 667 e 1.333 ações e nada da oferta sobra para a tesouraria", async () => {
    expect(await resultOf("FLA3")).toEqual({
      seasonId,
      clubId: club("FLA3"),
      cutPrice: 3500,
      demandAtCut: 4500,
      allocationNum: 2,
      allocationDen: 3,
      treasuryShares: 0,
      mmLotShares: LOT,
      settledAt: SETTLE_AT,
    });
    await expectSettleLine("ana", "FLA3", { shares: 1000, price: 3500, reserved: 1500 * 4000 });
    await expectSettleLine("bruno", "FLA3", { shares: 667, price: 3500, reserved: 1000 * 3700 });
    await expectSettleLine("carla", "FLA3", { shares: 1333, price: 3500, reserved: 2000 * 3500 });
    // A tesouraria recebe o dinheiro e o lote, e nenhuma sobra (sem linha de sobra).
    const lines = await settleEntries(treasury, "FLA3");
    expect(lines.map((l) => [l.cashDelta, l.sharesDelta, l.price])).toEqual([
      [(1000 + 667 + 1333) * 3500, 0, null],
      [0, LOT, 3500],
    ]);
    expect(lines.every((l) => l.refType === "ipo_result" && l.refId === String(club("FLA3")))).toBe(true);
  });

  it("ipo 21: atendida em 1.000 a R$ 35 com R$ 60.000 reservados, Ana paga R$ 35.000, recebe R$ 25.000 de volta e a tesouraria recebe os R$ 35.000", async () => {
    const [line] = await settleEntries(wallet("ana"), "FLA3");
    expect(line).toMatchObject({ cashDelta: -3_500_000, reservedCashDelta: -6_000_000, cashAfter: INITIAL_CASH - 3_500_000 });
    expect(await walletRow(wallet("ana"))).toMatchObject({ cash: INITIAL_CASH - 3_500_000, reservedCash: 0 });
    expect(await allocationOf("ana", "FLA3")).toMatchObject({ paid: 3_500_000, refunded: 2_500_000 });
    // Os R$ 35.000 de Ana estão no que a tesouraria recebeu pelo FLA3 (R$ 35.000 + R$ 23.345 + R$ 46.655).
    const [cash] = await settleEntries(treasury, "FLA3");
    expect(cash!.cashDelta).toBe(3_500_000 + 667 * 3500 + 1333 * 3500);
  });

  it("carteira 1: Ana vê 1.000 FLA3, preço médio R$ 35,00 e custo R$ 35.000,00", async () => {
    const position = await positionOf(wallet("ana"), "FLA3");
    expect(position).toMatchObject({ shares: 1000, reservedShares: 0, cost: 3_500_000, realized: 0 });
    expect(position!.cost / position!.shares).toBe(3500);
  });

  it("ipo 29: demanda de 4.500 no corte → 3.000 para os jogadores, 600 do lote para a tesouraria sem pagar e o clube com 3.600 ações", async () => {
    expect((await sharesOf("ana", "FLA3")) + (await sharesOf("bruno", "FLA3")) + (await sharesOf("carla", "FLA3"))).toBe(OFFER);
    expect((await positionOf(treasury, "FLA3"))!.shares).toBe(LOT);
    // O lote entra sem dinheiro: a única linha de caixa da tesouraria é o que os jogadores pagaram.
    const lotLine = (await settleEntries(treasury, "FLA3")).find((l) => l.sharesDelta === LOT)!;
    expect(lotLine.cashDelta).toBe(0);
    expect((await seasonClub("FLA3")).totalShares).toBe(3600);
  });

  it("ipo 17: no empate do resto do rateio, a ação que sobra vai para a oferta alterada primeiro, mesmo registrada depois", async () => {
    expect(await resultOf("PAL3")).toMatchObject({ cutPrice: 4000, demandAtCut: 3750, allocationNum: 4, allocationDen: 5, treasuryShares: 0 });
    // xavi_um tem o id menor (registrou primeiro), mas a última alteração dele é depois da de xavi_dois.
    expect((await bidOf("xavi_um", "PAL3")).id).toBeLessThan((await bidOf("xavi_dois", "PAL3")).id);
    expect((await bidOf("xavi_um", "PAL3")).updatedAt.getTime()).toBeGreaterThan((await bidOf("xavi_dois", "PAL3")).updatedAt.getTime());
    await expectSettleLine("xavi_dois", "PAL3", { shares: 803, price: 4000, reserved: 1003 * 4000 });
    await expectSettleLine("xavi_um", "PAL3", { shares: 802, price: 4000, reserved: 1003 * 4000 });
    await expectSettleLine("xavi_tres", "PAL3", { shares: 1395, price: 4000, reserved: 1744 * 4000 });
  });

  it("ipo 18: 1.200 no piso → preço no piso, os 1.200 atendidos por inteiro e 1.800 para a tesouraria", async () => {
    expect(await resultOf("VAS3")).toMatchObject({ cutPrice: FLOOR, demandAtCut: 1200, allocationNum: 1, allocationDen: 1, treasuryShares: 1800, mmLotShares: LOT });
    await expectSettleLine("dora", "VAS3", { shares: 1200, price: FLOOR, reserved: 1200 * FLOOR });
    const lines = await settleEntries(treasury, "VAS3");
    expect(lines.map((l) => [l.cashDelta, l.sharesDelta, l.price])).toEqual([
      [1200 * FLOOR, 0, null],
      [0, 1800, FLOOR],
      [0, LOT, FLOOR],
    ]);
    expect((await positionOf(treasury, "VAS3"))!.shares).toBe(1800 + LOT);
  });

  it("ipo 19: exatamente 3.000 a R$ 40 → preço R$ 40, sem rateio (fração 1) e nada da oferta para a tesouraria", async () => {
    expect(await resultOf("BOT3")).toMatchObject({ cutPrice: 4000, demandAtCut: 3000, allocationNum: 1, allocationDen: 1, treasuryShares: 0 });
    await expectSettleLine("edu", "BOT3", { shares: 1000, price: 4000, reserved: 1000 * 4000 });
    await expectSettleLine("fabi", "BOT3", { shares: 2000, price: 4000, reserved: 2000 * 4000 });
    expect((await positionOf(treasury, "BOT3"))!.shares).toBe(LOT);
  });

  it("ipo 20: clube sem oferta → as 3.000 ações e o lote vão para a tesouraria, e o preço de referência é o piso", async () => {
    expect(await resultOf("COR3")).toMatchObject({ cutPrice: FLOOR, demandAtCut: 0, allocationNum: 1, allocationDen: 1, treasuryShares: OFFER, mmLotShares: LOT });
    const lines = await settleEntries(treasury, "COR3");
    // Sem dinheiro (ninguém pagou): só a sobra e o lote, pelo piso.
    expect(lines.map((l) => [l.cashDelta, l.sharesDelta, l.price])).toEqual([
      [0, OFFER, FLOOR],
      [0, LOT, FLOOR],
    ]);
    expect((await positionOf(treasury, "COR3"))!.shares).toBe(OFFER + LOT);
    expect(await seasonClub("COR3")).toMatchObject({ ipoPrice: FLOOR, lastPrice: FLOOR, totalShares: OFFER + LOT });
  });

  it("ipo 22: oferta abaixo do corte → nenhuma ação e a reserva inteira de volta ao caixa livre", async () => {
    expect(await resultOf("SAO3")).toMatchObject({ cutPrice: 4000, demandAtCut: 3000, allocationNum: 1, allocationDen: 1 });
    await expectSettleLine("ivo", "SAO3", { shares: 0, price: 4000, reserved: 500 * 3100 });
    expect(await walletRow(wallet("ivo"))).toMatchObject({ cash: INITIAL_CASH, reservedCash: 0 });
    expect(await sharesOf("ivo", "SAO3")).toBe(0);
    // Quem passou do teto da oferta paga o corte e recebe a diferença da reserva.
    await expectSettleLine("hugo", "SAO3", { shares: 1500, price: 4000, reserved: 1500 * 4500 });
    await expectSettleLine("gil", "SAO3", { shares: 1500, price: 4000, reserved: 1500 * 4000 });
  });

  it("proposta 8: o rateio com a conta excluída (GRE3) e com a bloqueada (INT3) é igual ao do SAN3, sem ninguém de fora", async () => {
    /** O resultado e as alocações do clube, sem o que muda de um clube para o outro (o clube e a oferta). */
    const view = async (ticker: string) => {
      const r = (await resultOf(ticker))!;
      const result = [r.cutPrice, r.demandAtCut, r.allocationNum, r.allocationDen, r.treasuryShares, r.mmLotShares, r.settledAt];
      const prefix = ticker.slice(0, 3).toLowerCase();
      const allocations = [];
      for (const suffix of ["um", "dois", "tres"]) {
        const a = (await allocationOf(`${prefix}_${suffix}`, ticker))!;
        allocations.push({ shares: a.shares, paid: a.paid, refunded: a.refunded });
      }
      return { result, allocations };
    };
    const control = await view("SAN3");
    expect(control.result).toEqual([3800, 3500, 6, 7, 0, LOT, SETTLE_AT]);
    expect(control.allocations.map((a) => a.shares)).toEqual([1714, 1286, 0]);
    expect(await view("GRE3")).toEqual(control);
    expect(await view("INT3")).toEqual(control);
    // A conta bloqueada continua dona do que recebeu; a excluída recebeu e espera o encerramento da carteira.
    expect(await sharesOf("int_um", "INT3")).toBe(1714);
    expect(await sharesOf("gre_dois", "GRE3")).toBe(1286);
    await expectSettleLine("gre_dois", "GRE3", { shares: 1286, price: 3800, reserved: 1500 * 3800 });
  });

  it("ipo 24: ipo_price e last_price iguais ao corte, sem negócio (last_trade_at nulo), e total_shares = oferta + lote", async () => {
    for (const ticker of TICKERS) {
      const { cutPrice } = (await resultOf(ticker))!;
      expect(await seasonClub(ticker), ticker).toMatchObject({ ipoPrice: cutPrice, lastPrice: cutPrice, lastTradeAt: null, totalShares: OFFER + LOT });
    }
  });

  it("ipo 23: nenhum caixa negativo nem reserva sobrando, ações = oferta + lote em cada clube e o dinheiro total igual ao de antes", async () => {
    const rows = await database.db.select().from(wallets).where(eq(wallets.seasonId, seasonId));
    for (const w of rows) {
      expect(w.cash).toBeGreaterThanOrEqual(0);
      expect(w.reservedCash).toBe(0);
    }
    await assertSharesConserved(database.db, seasonId);
    for (const ticker of TICKERS) {
      const held = await database.db.select({ shares: positions.shares }).from(positions).where(eq(positions.clubId, club(ticker)));
      expect(held.reduce((s, p) => s + p.shares, 0), ticker).toBe(OFFER + LOT);
    }
    // O dinheiro só muda de mão: o que os jogadores pagaram está na tesouraria.
    expect(await totalCash(database.db, seasonId)).toBe(cashBefore);
    const paid = (await database.db.select().from(ipoAllocations)).reduce((s, a) => s + a.paid, 0);
    expect((await walletRow(treasury)).cash).toBe(paid);
  });

  it("repetível: a segunda passada pula os 9 clubes e não muda nada", async () => {
    const snapshot = async () => ({
      wallets: await database.db.select().from(wallets).where(eq(wallets.seasonId, seasonId)).orderBy(asc(wallets.id)),
      entries: (await database.db.select().from(walletEntries)).length,
      allocations: (await database.db.select().from(ipoAllocations)).length,
      results: await database.db.select().from(ipoResults).orderBy(asc(ipoResults.clubId)),
      clubs: await database.db.select().from(seasonClubs).where(eq(seasonClubs.seasonId, seasonId)).orderBy(asc(seasonClubs.clubId)),
    });
    const before = await snapshot();
    const again = await settlement.settleDue(new Date(SETTLE_AT.getTime() + MINUTE));
    expect(again).toEqual({ status: "ran", seasonId, settled: [], skipped: TICKERS, failed: [], pending: 0 });
    expect(await snapshot()).toEqual(before);
  });

  it("conta excluída: depois da liquidação, o account-closeout da F5 leva as 1.286 GRE3 para a tesouraria e zera a carteira", async () => {
    const deletion = app.get(AccountDeletionService);
    expect(await deletion.closeoutPending()).toBe(1);
    expect(await walletRow(wallet("gre_dois"))).toMatchObject({ cash: 0, reservedCash: 0 });
    expect(await sharesOf("gre_dois", "GRE3")).toBe(0);
    expect((await positionOf(treasury, "GRE3"))!.shares).toBe(LOT + 1286);
    // O bloqueado não é encerrado: continua dono das ações.
    expect(await sharesOf("int_um", "INT3")).toBe(1714);
    expect(await deletion.closeoutPending()).toBe(0);
    await assertSharesConserved(database.db, seasonId);
  });

  it("com a temporada em trading (ou em preparing), a passada não faz nada, nem com um clube sem resultado", async () => {
    // Um clube sem resultado de propósito: fora de ipo_closed, mesmo assim nada é liquidado.
    await database.db.delete(ipoResults).where(and(eq(ipoResults.seasonId, seasonId), eq(ipoResults.clubId, club("COR3"))));
    const entries = (await database.db.select().from(walletEntries)).length;
    try {
      for (const status of ["trading", "preparing"]) {
        await database.db.update(seasons).set({ status }).where(eq(seasons.id, seasonId));
        expect(await settlement.settleDue(SETTLE_AT), status).toEqual({ status: "idle" });
      }
      expect((await database.db.select().from(walletEntries)).length).toBe(entries);
      expect(await resultOf("COR3")).toBeUndefined();
    } finally {
      // Devolve o resultado como estava, para as invariantes do fim.
      await database.db.insert(ipoResults).values({
        seasonId, clubId: club("COR3"), cutPrice: FLOOR, demandAtCut: 0, allocationNum: 1, allocationDen: 1,
        treasuryShares: OFFER, mmLotShares: LOT, settledAt: SETTLE_AT,
      });
      await database.db.update(seasons).set({ status: "ipo_closed" }).where(eq(seasons.id, seasonId));
    }
  });

  it("invariantes: carteiras iguais à soma do extrato e ações de cada clube = oferta + lote", async () => {
    await assertLedgerConsistent(database.db, seasonId);
    await assertSharesConserved(database.db, seasonId);
  });
});
