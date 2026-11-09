import "reflect-metadata";
import { Logger } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type IpoClubSettlement, settleIpoClub } from "@futbolsa/engine";
import { FixedClock } from "../../src/infra/clock/index.js";
import type { Tx } from "../../src/infra/db/index.js";
import {
  clubs,
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
import { PortfolioLedger } from "../../src/modules/portfolio/index.js";
import type { Movement } from "../../src/modules/portfolio/ledger/index.js";
import { createAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { INITIAL_CASH, openWallets, rng, seedSeason, sleep } from "../support/fixtures.js";
import { assertLedgerConsistent, assertSharesConserved, totalCash } from "../support/invariants.js";

/** Cada cenário roda 20 vezes, cada vez numa temporada nova, como os testes das travas da F4. */
const ROUNDS = 20;
/** Jogadores por temporada. */
const PLAYERS = 8;
/** Oferta menor que a de produção, para as ofertas sorteadas darem rateio num clube e sobra noutro. */
const OFFER = 1000;
const OPENS_AT = new Date("2027-03-28T19:00:00Z");
const CLOSES_AT = new Date("2027-04-04T19:00:00Z");
const DURING = new Date("2027-03-30T15:00:00Z");
const SETTLE_AT = new Date("2027-04-04T19:01:00Z");
const NEXT_PASS = new Date("2027-04-04T19:02:00Z");
/** Os 4 clubes do Clube dos Treze na Série B que completam os 24 listados. */
const SERIE_B = ["CTA3", "CTB3", "CTC3", "CTD3"];
/** O 8º clube em diante falha no cenário 9. */
const SETTLED_BEFORE_FAILURE = 7;
/**
 * Atraso máximo sorteado para a segunda passada (cenário 8) e para as exclusões (cenário 10): uma
 * passada pelos 24 clubes leva mais que isso, então eles caem no começo ou no meio dela.
 */
const MAX_DELAY_MS = 400;

type Band = { floor: number; ceiling: number };
type Round = { seasonId: number; treasury: number; players: Array<{ userId: string; walletId: number }> };

/** Embaralha uma cópia com o sorteio dado (Fisher-Yates), para a rodada se repetir com a mesma semente. */
function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Faz o papel de uma queda no meio da liquidação: a linha da tesouraria dos clubes marcados falha,
 * depois de as linhas dos jogadores, as alocações e as ofertas `settled` já terem sido gravadas na
 * transação. É só um `PortfolioLedger` trocado, como o Nest trocaria pelo `overrideProvider`.
 */
class FailingLedger extends PortfolioLedger {
  treasury = 0;
  failing = new Set<number>();

  override post(tx: Tx, movement: Movement) {
    if (movement.walletId === this.treasury && movement.clubId !== undefined && this.failing.has(movement.clubId)) {
      return Promise.reject(new Error(`falha forçada do teste no clube ${movement.clubId}`));
    }
    return super.post(tx, movement);
  }
}

describe("liquidação do IPO sob concorrência, contra o Postgres", () => {
  const t = useTestDatabase(30);
  const clock = new FixedClock(DURING);
  let app: NestFastifyApplication;
  let bids: IpoBidsService;
  let settlement: IpoSettlementService;
  let clubIds: Map<string, number>;
  /** Os 24 listados, em ordem de ticker (a ordem da liquidação). */
  let tickers: string[];
  const bands = new Map<string, Band>();
  let year = 2027;

  beforeAll(async () => {
    app = await createTestApp({ db: t.db, clock, override: withTestAuth(clock) });
    bids = app.get(IpoBidsService);
    settlement = app.get(IpoSettlementService);
    await seedSeason(t.db, year);
    await t.db.insert(clubs).values(SERIE_B.map((ticker, i) => ({ ticker, name: `Clube dos Treze na Série B ${i + 1} (teste)` })));
    clubIds = new Map((await t.db.select({ id: clubs.id, ticker: clubs.ticker }).from(clubs)).map((c) => [c.ticker!, c.id]));
    tickers = [...clubIds.keys()].sort();
    expect(tickers).toHaveLength(24);
    // Faixas diferentes por clube (centro de R$ 15 a R$ 49,50, ±40%), como a abertura grava.
    tickers.forEach((ticker, i) => {
      const center = 1500 + 150 * i;
      bands.set(ticker, { floor: Math.round(center * 0.6), ceiling: Math.round(center * 1.4) });
    });
  });
  afterAll(() => app?.close());

  /**
   * Uma temporada nova (a atual) no estado que o fechamento deixa: 24 clubes com a faixa, a tesouraria,
   * `PLAYERS` jogadores com R$ 100.000,00 e as ofertas sorteadas pelo serviço das ofertas, umas
   * canceladas, e a temporada em `ipo_closed` pela tarefa de fechar.
   */
  async function prepareRound(random: () => number): Promise<Round> {
    year++;
    await t.db.update(seasons).set({ status: "closed" }).where(ne(seasons.year, year));
    const { seasonId } = await seedSeason(t.db, year);
    await t.db.insert(seasonClubs).values(
      tickers.map((ticker) => {
        const band = bands.get(ticker)!;
        return {
          seasonId,
          clubId: clubIds.get(ticker)!,
          division: SERIE_B.includes(ticker) ? "B" : "A",
          bandCenter: Math.round((band.floor + band.ceiling) / 2),
          bandFloor: band.floor,
          bandCeiling: band.ceiling,
        };
      }),
    );
    await t.db
      .update(seasons)
      .set({ status: "ipo_open", offerSize: OFFER, ipoOpensAt: OPENS_AT, ipoClosesAt: CLOSES_AT, firstKickoff: new Date("2027-04-11T19:00:00Z") })
      .where(eq(seasons.id, seasonId));
    const [treasury] = await openWallets(t.db, seasonId, [{ type: "treasury" }]);
    const userIds: string[] = [];
    for (let i = 0; i < PLAYERS; i++) userIds.push((await createAccount(t.db)).id);
    const walletIds = await openWallets(t.db, seasonId, userIds.map((userId) => ({ type: "user", userId }) as const));
    const players = userIds.map((userId, i) => ({ userId, walletId: walletIds[i]! }));

    clock.set(DURING);
    for (const p of players) {
      const chosen = shuffled(tickers, random).slice(0, 6 + Math.floor(random() * 6));
      let free = INITIAL_CASH;
      for (const ticker of chosen) {
        const band = bands.get(ticker)!;
        // Do piso a um pouco acima do teto (a reserva fica no teto), de 50 a 849 ações.
        const maxPrice = band.floor + Math.floor(random() * (band.ceiling - band.floor + 500));
        const quantity = 50 + Math.floor(random() * 800);
        const reserve = quantity * Math.min(maxPrice, band.ceiling);
        if (reserve > free) continue;
        clock.advance(1000);
        await bids.place(p.walletId, ticker, { quantity, maxPrice, expect: "new" });
        free -= reserve;
        if (random() < 0.1) {
          clock.advance(1000);
          await bids.cancel(p.walletId, ticker);
          free += reserve;
        }
      }
    }
    expect(await app.get(IpoClosingService).closeIfDue(CLOSES_AT)).toMatchObject({ status: "closed", seasonId });
    clock.set(SETTLE_AT);
    return { seasonId, treasury: treasury!, players };
  }

  /** O que a liquidação tem de dar: o motor chamado direto com as ofertas ativas de cada clube. */
  async function expectedOf(seasonId: number): Promise<Map<number, IpoClubSettlement>> {
    const [season] = await t.db.select().from(seasons).where(eq(seasons.id, seasonId));
    const listed = await t.db.select().from(seasonClubs).where(eq(seasonClubs.seasonId, seasonId));
    const active = await t.db
      .select()
      .from(ipoBids)
      .where(and(eq(ipoBids.seasonId, seasonId), eq(ipoBids.status, "active")))
      .orderBy(asc(ipoBids.id));
    return new Map(
      listed.map((c) => [
        c.clubId,
        settleIpoClub({
          offer: season!.offerSize!,
          band: { floor: c.bandFloor!, ceiling: c.bandCeiling! },
          lotBp: season!.mmLotBp,
          bids: active
            .filter((b) => b.clubId === c.clubId)
            .map((b) => ({ id: b.id, walletId: b.walletId, quantity: b.quantity, maxPrice: b.maxPrice, reserved: b.reserved, updatedAt: b.updatedAt.getTime() })),
        }),
      ]),
    );
  }

  /** As carteiras da temporada como uma liquidação só deixaria, a partir de como estão antes dela. */
  async function expectedWallets(seasonId: number, treasury: number, expected: Map<number, IpoClubSettlement>) {
    const state = new Map(
      (await t.db.select().from(wallets).where(eq(wallets.seasonId, seasonId))).map((w) => [
        w.id,
        { cash: w.cash, reservedCash: w.reservedCash, shares: new Map<number, number>() },
      ]),
    );
    const reservedOf = new Map(
      (await t.db.select().from(ipoBids).where(and(eq(ipoBids.seasonId, seasonId), eq(ipoBids.status, "active")))).map((b) => [b.id, b.reserved]),
    );
    const addShares = (walletId: number, clubId: number, shares: number) => {
      const s = state.get(walletId)!.shares;
      if (shares > 0) s.set(clubId, (s.get(clubId) ?? 0) + shares);
    };
    for (const [clubId, r] of expected) {
      for (const a of r.allocations) {
        const w = state.get(a.walletId)!;
        w.cash -= a.paid;
        w.reservedCash -= reservedOf.get(a.bidId)!;
        addShares(a.walletId, clubId, a.shares);
      }
      state.get(treasury)!.cash += r.treasuryCash;
      addShares(treasury, clubId, r.leftoverShares + r.lotShares);
    }
    return state;
  }

  /** As ações de cada carteira por clube, só as posições com ações. */
  async function sharesByWallet(seasonId: number): Promise<Map<number, Map<number, number>>> {
    const rows = await t.db
      .select({ walletId: positions.walletId, clubId: positions.clubId, shares: positions.shares })
      .from(positions)
      .innerJoin(wallets, eq(wallets.id, positions.walletId))
      .where(eq(wallets.seasonId, seasonId));
    const out = new Map<number, Map<number, number>>();
    for (const r of rows) {
      if (r.shares === 0) continue;
      if (!out.has(r.walletId)) out.set(r.walletId, new Map());
      out.get(r.walletId)!.set(r.clubId, r.shares);
    }
    return out;
  }

  /** O resultado gravado (clube, alocações, ofertas) é o do motor chamado direto. */
  async function expectResultsAsEngine(seasonId: number, expected: Map<number, IpoClubSettlement>) {
    const results = await t.db.select().from(ipoResults).where(eq(ipoResults.seasonId, seasonId));
    expect(results).toHaveLength(tickers.length);
    for (const r of results) {
      const e = expected.get(r.clubId)!;
      expect(r).toMatchObject({
        cutPrice: e.cutPrice,
        demandAtCut: e.demandAtCut,
        allocationNum: e.ratio.num,
        allocationDen: e.ratio.den,
        treasuryShares: e.leftoverShares,
        mmLotShares: e.lotShares,
      });
    }
    const seasonBids = await t.db.select().from(ipoBids).where(eq(ipoBids.seasonId, seasonId));
    const allocations = await t.db
      .select()
      .from(ipoAllocations)
      .where(inArray(ipoAllocations.bidId, seasonBids.map((b) => b.id)));
    const expectedAllocations = [...expected.values()].flatMap((e) => e.allocations);
    expect(allocations).toHaveLength(expectedAllocations.length);
    const byBid = new Map(allocations.map((a) => [a.bidId, a]));
    for (const a of expectedAllocations) expect(byBid.get(a.bidId)).toEqual({ bidId: a.bidId, shares: a.shares, paid: a.paid, refunded: a.refunded });
    // Nenhuma oferta ativa sobrou; as canceladas antes do fechamento ficaram de fora do rateio.
    for (const b of seasonBids) {
      expect(b.status).not.toBe("active");
      expect(byBid.has(b.id)).toBe(b.status === "settled");
    }
    // Uma linha `ipo_settle` por oferta (nada repetido), com a referência dela.
    const lines = await t.db
      .select()
      .from(walletEntries)
      .where(and(eq(walletEntries.kind, "ipo_settle"), eq(walletEntries.refType, "ipo_bid"), inArray(walletEntries.refId, seasonBids.map((b) => String(b.id)))));
    expect(lines).toHaveLength(expectedAllocations.length);
    expect(new Set(lines.map((l) => l.refId)).size).toBe(lines.length);
  }

  /** Carteiras (caixa, reserva e ações) iguais às de uma liquidação só, menos as `except`. */
  async function expectWalletsAs(seasonId: number, state: Awaited<ReturnType<typeof expectedWallets>>, except: ReadonlySet<number> = new Set()) {
    const actual = new Map((await t.db.select().from(wallets).where(eq(wallets.seasonId, seasonId))).map((w) => [w.id, w]));
    const shares = await sharesByWallet(seasonId);
    for (const [walletId, e] of state) {
      if (except.has(walletId)) continue;
      expect(actual.get(walletId), `carteira ${walletId}`).toMatchObject({ cash: e.cash, reservedCash: e.reservedCash });
      expect(shares.get(walletId) ?? new Map(), `ações da carteira ${walletId}`).toEqual(e.shares);
    }
  }

  async function expectInvariants(seasonId: number) {
    await assertLedgerConsistent(t.db, seasonId);
    await assertSharesConserved(t.db, seasonId);
  }

  const ran = (r: IpoSettleResult) => {
    if (r.status !== "ran") throw new Error(`a passada não rodou: ${JSON.stringify(r)}`);
    return r;
  };

  it(
    "8. duas passadas da tarefa ao mesmo tempo: um ipo_results por clube e o mesmo caixa final de uma liquidação só",
    async () => {
      const random = rng(8080);
      // A segunda instância da API, com o mesmo banco: nada é compartilhado em memória.
      const other = new IpoSettlementService(t.db, new PortfolioLedger());
      let mixed = 0;
      let skippedUpfront = 0;
      for (let round = 0; round < ROUNDS; round++) {
        const r = await prepareRound(random);
        const expected = await expectedOf(r.seasonId);
        const state = await expectedWallets(r.seasonId, r.treasury, expected);
        const cashBefore = await totalCash(t.db, r.seasonId);

        // A segunda passada sai junto ou um pouco depois (a tarefa de cada instância não roda no mesmo
        // milissegundo): umas vezes espera a trava de cada clube, outras já acha clubes liquidados.
        const delay = round % 4 === 0 ? 0 : Math.floor(random() * MAX_DELAY_MS);
        const [a, b] = (
          await Promise.all([settlement.settleDue(SETTLE_AT), sleep(delay).then(() => other.settleDue(SETTLE_AT))])
        ).map(ran);
        // Cada clube foi liquidado por uma passada só; a outra o pulou. Nenhuma falhou.
        for (const pass of [a!, b!]) {
          expect(pass.failed).toEqual([]);
          expect(pass.pending).toBe(0);
          expect([...pass.settled, ...pass.skipped].sort()).toEqual(tickers);
        }
        expect([...a!.settled, ...b!.settled].sort()).toEqual(tickers);
        expect(a!.skipped).toEqual(tickers.filter((x) => b!.settled.includes(x)));
        if (a!.settled.length > 0 && b!.settled.length > 0) mixed++;
        if (b!.skipped.length > 0 && b!.settled.length === 0 && delay > 0) skippedUpfront++;

        await expectResultsAsEngine(r.seasonId, expected);
        await expectWalletsAs(r.seasonId, state);
        expect(await totalCash(t.db, r.seasonId)).toBe(cashBefore);
        await expectInvariants(r.seasonId);
      }
      // Para a revisão: quantas rodadas as duas passadas dividiram os clubes. A que chega primeiro tende a
      // liquidar todos: a outra espera a trava do clube em que ela está e pula, clube a clube.
      console.info(`cenário 8: as passadas dividiram os clubes em ${mixed} de ${ROUNDS} rodadas; a atrasada só pulou em ${skippedUpfront}`);
    },
    600_000,
  );

  it(
    "9. liquidação interrompida depois do 7º clube: a passada seguinte liquida os que faltam, sem repetir os sete",
    async () => {
      const random = rng(9090);
      const ledger = new FailingLedger();
      const failingPass = new IpoSettlementService(t.db, ledger);
      const firstSeven = tickers.slice(0, SETTLED_BEFORE_FAILURE);
      const rest = tickers.slice(SETTLED_BEFORE_FAILURE);
      const logged = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
      try {
        for (let round = 0; round < ROUNDS; round++) {
          const r = await prepareRound(random);
          const expected = await expectedOf(r.seasonId);
          const state = await expectedWallets(r.seasonId, r.treasury, expected);
          const restIds = rest.map((x) => clubIds.get(x)!);
          ledger.treasury = r.treasury;
          ledger.failing = new Set(restIds);
          logged.mockClear();

          const first = ran(await failingPass.settleDue(SETTLE_AT));
          expect(first.settled).toEqual(firstSeven);
          expect(first.skipped).toEqual([]);
          expect(first.failed.map((f) => f.ticker)).toEqual(rest);
          expect(first.pending).toBe(rest.length);
          // Cada falha foi registrada no log, com o clube; nenhuma passou em silêncio.
          expect(logged).toHaveBeenCalledTimes(rest.length);
          rest.forEach((ticker, i) => expect(String(logged.mock.calls[i]![0])).toContain(ticker));

          // A transação do clube que falhou foi desfeita inteira: nada das ofertas, das carteiras nem do clube.
          const restBids = await t.db
            .select()
            .from(ipoBids)
            .where(and(eq(ipoBids.seasonId, r.seasonId), inArray(ipoBids.clubId, restIds), ne(ipoBids.status, "cancelled")));
          for (const b of restBids) expect(b.status).toBe("active");
          if (restBids.length > 0) {
            expect(await t.db.select().from(ipoAllocations).where(inArray(ipoAllocations.bidId, restBids.map((b) => b.id)))).toHaveLength(0);
          }
          const restLines = await t.db
            .select({ id: walletEntries.id })
            .from(walletEntries)
            .innerJoin(wallets, eq(wallets.id, walletEntries.walletId))
            .where(and(eq(wallets.seasonId, r.seasonId), eq(walletEntries.kind, "ipo_settle"), inArray(walletEntries.clubId, restIds)));
          expect(restLines).toHaveLength(0);
          for (const c of await t.db.select().from(seasonClubs).where(and(eq(seasonClubs.seasonId, r.seasonId), inArray(seasonClubs.clubId, restIds)))) {
            expect(c).toMatchObject({ ipoPrice: null, lastPrice: null, totalShares: 0 });
          }
          await assertLedgerConsistent(t.db, r.seasonId);

          // A passada seguinte (a tarefa no minuto seguinte, sem a falha) termina sem tocar nos sete.
          const second = ran(await settlement.settleDue(NEXT_PASS));
          expect(second).toMatchObject({ settled: rest, skipped: firstSeven, failed: [], pending: 0 });
          const settledAt = new Map(
            (await t.db.select().from(ipoResults).where(eq(ipoResults.seasonId, r.seasonId))).map((x) => [x.clubId, x.settledAt.getTime()]),
          );
          for (const x of firstSeven) expect(settledAt.get(clubIds.get(x)!)).toBe(SETTLE_AT.getTime());
          for (const x of rest) expect(settledAt.get(clubIds.get(x)!)).toBe(NEXT_PASS.getTime());

          await expectResultsAsEngine(r.seasonId, expected);
          await expectWalletsAs(r.seasonId, state);
          await expectInvariants(r.seasonId);
        }
      } finally {
        logged.mockRestore();
      }
    },
    600_000,
  );

  it(
    "10. exclusões de conta e o account-closeout ao mesmo tempo que a liquidação: o rateio não muda e as ações das excluídas acabam na tesouraria",
    async () => {
      const random = rng(1010);
      const deletion = app.get(AccountDeletionService);
      const outcomes = { after_ipo_settlement: 0, done: 0 };
      for (let round = 0; round < ROUNDS; round++) {
        const r = await prepareRound(random);
        const expected = await expectedOf(r.seasonId);
        const state = await expectedWallets(r.seasonId, r.treasury, expected);
        // Três jogadores saem: dois em momentos sorteados do começo da passada (a exclusão espera a
        // liquidação) e um no instante em que ela termina, com a temporada ainda em ipo_closed (a
        // carteira é encerrada na hora, ao mesmo tempo que a tarefa account-closeout).
        const leaving = shuffled(r.players, random).slice(0, 3);
        const delays = leaving.map(() => Math.floor(random() * MAX_DELAY_MS));
        const leavingWallets = new Set(leaving.map((p) => p.walletId));

        let settling = true;
        const pass = settlement.settleDue(SETTLE_AT).finally(() => {
          settling = false;
        });
        const deletions = leaving.map(async (p, i) => {
          if (i === 2) await pass;
          else await sleep(delays[i]!);
          return deletion.deleteAccount(p.userId);
        });
        // A tarefa `account-closeout` rodando sem parar enquanto a liquidação anda.
        const closeouts = (async () => {
          while (settling) {
            await deletion.closeoutPending();
            await sleep(5);
          }
        })();
        const [result, deleted] = await Promise.all([pass, Promise.all(deletions), closeouts]);
        // E mais uma vez depois (o minuto seguinte da tarefa), para quem saiu durante a liquidação.
        await deletion.closeoutPending();

        expect(ran(result)).toMatchObject({ settled: tickers, skipped: [], failed: [], pending: 0 });
        for (const d of deleted) {
          expect(["after_ipo_settlement", "done"]).toContain(d.walletCloseout);
          outcomes[d.walletCloseout]++;
        }
        // O rateio é o de uma liquidação sem nenhuma exclusão.
        await expectResultsAsEngine(r.seasonId, expected);
        // Quem ficou está como numa liquidação só; quem saiu tem a carteira zerada.
        await expectWalletsAs(r.seasonId, state, new Set([...leavingWallets, r.treasury]));
        const shares = await sharesByWallet(r.seasonId);
        for (const p of leaving) {
          expect((await t.db.select().from(users).where(eq(users.id, p.userId)))[0]!.status).toBe("deleted");
          expect((await t.db.select().from(wallets).where(eq(wallets.id, p.walletId)))[0]).toMatchObject({ cash: 0, reservedCash: 0 });
          expect(shares.get(p.walletId)).toBeUndefined();
        }
        // A tesouraria: a sobra e o lote de cada clube, mais as ações que as contas excluídas receberam.
        const treasuryShares = new Map(state.get(r.treasury)!.shares);
        for (const p of leaving) {
          for (const [clubId, n] of state.get(p.walletId)!.shares) treasuryShares.set(clubId, (treasuryShares.get(clubId) ?? 0) + n);
        }
        expect(shares.get(r.treasury)).toEqual(treasuryShares);
        expect((await t.db.select().from(wallets).where(eq(wallets.id, r.treasury)))[0]!.cash).toBe(state.get(r.treasury)!.cash);
        await expectInvariants(r.seasonId);
      }
      // Houve exclusão no meio da liquidação (encerrada depois pelo account-closeout) e logo depois dela.
      expect(outcomes.after_ipo_settlement).toBeGreaterThan(0);
      expect(outcomes.done).toBeGreaterThan(0);
      console.info(`cenário 10: ${outcomes.after_ipo_settlement} exclusões esperaram a liquidação e ${outcomes.done} vieram depois dela`);
    },
    600_000,
  );

  it("invariantes: carteiras iguais à soma do extrato e ações conservadas em todas as temporadas", async () => {
    for (const s of await t.db.select({ id: seasons.id }).from(seasons)) await expectInvariants(s.id);
  });
});
