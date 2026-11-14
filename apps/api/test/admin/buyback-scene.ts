import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, asc, eq } from "drizzle-orm";
import type { FixedClock } from "../../src/infra/clock/index.js";
import { type Database, lockWallets, withTransaction } from "../../src/infra/db/index.js";
import {
  clubs,
  cupPhases,
  matches,
  payoutEvents,
  positions,
  seasonRules,
  seasons,
  standings,
  users,
  wallets,
} from "../../src/infra/db/schema/index.js";
import { post } from "../../src/modules/portfolio/ledger/index.js";
import { EquityAt } from "../../src/modules/portfolio/valuation/equity-at.js";
import { correctionScene, type Season } from "../payouts/correction-scene.js";

/**
 * O cenário do fim da temporada para os testes da recompra (F15, T3 a T5), sobre o da correção (`correctionScene`):
 * uma temporada em negociação com os 18 clubes listados e as cinco competições fechando, cada uma com o mínimo de
 * jogos. Os valores por ação das finais e da Série B são ajustados para os totais dos critérios:
 *
 * - Série B (14/11/2027): GRE3 empata com um clube de fora (1 ponto × R$ 2,75) e termina em 3º (acesso de R$ 2,00):
 *   R$ 4,75 → recompra de R$ 7,13 (critério 23);
 * - Sul-Americana (final em 20/11): SAO3 campeão, título de R$ 12,90 → recompra de R$ 19,35 (Carteira 21);
 * - Libertadores (final em 27/11): PAL3 campeão, título de R$ 5,55 → recompra de R$ 8,33 (critério 18);
 * - Série A (05/12, 18h de Brasília): só JUV3 × RBB3, que estão fora da lista: ninguém recebe;
 * - Copa do Brasil (final em 19/12, das 16h às 18h de Brasília): FLA3 campeão, título de R$ 39,40 → recompra de
 *   R$ 59,10 (critério 17). O placar é registrado às 18h15 (critério 19).
 *
 * Os outros clubes listados não pagam nada: recompra de R$ 0,00 (critério 24).
 */

export const at = (iso: string) => new Date(iso);
export const B_END = at("2027-11-14T21:00:00Z");
export const SULA_END = at("2027-11-21T02:30:00Z");
export const LIB_END = at("2027-11-28T02:30:00Z");
/** O fim da Série A: 2027-12-05 às 18h de Brasília. */
export const A_END = at("2027-12-05T21:00:00Z");
/** O apito final da Copa do Brasil: 2027-12-19 às 18h de Brasília. */
export const FINAL_END = at("2027-12-19T21:00:00Z");
/** Quando o jogo registra o placar da final (18h15): o D da recompra. */
export const REGISTERED = at("2027-12-19T21:15:00Z");

/** Clube do seed pelo ticker, ou de fora da lista (sem ticker) por `out0` a `out5`. */
export type Side = string;

export interface FinalSpec {
  home: Side;
  away: Side;
  /** `null`: a final ainda sem placar (agendada). */
  score: [number, number] | null;
}

export interface EndSpec {
  cdb?: FinalSpec;
  lib?: FinalSpec;
  sula?: FinalSpec;
  /** O título de cada copa, em centavos (padrão: os dos critérios; `null` mantém o da temporada). */
  titles?: { cdb?: number | null; lib?: number | null; sula?: number | null };
  /** GRE3 na Série B com o empate e o 3º lugar (padrão: sim); sem isso a Série B é só entre clubes de fora. */
  greB?: boolean;
}

export const TITLES = { cdb: 3_940, lib: 555, sula: 1_290 };
export const BUYBACKS = { FLA3: 5_910, PAL3: 833, GRE3: 713, SAO3: 1_935 };

export interface EndMatches {
  cdb: number;
  lib: number;
  sula: number;
  a: number;
  b: number;
}

export function buybackScene(db: () => Database, app: () => NestFastifyApplication, clock: FixedClock, firstYear?: number) {
  const base = correctionScene(db, app, clock, firstYear);
  let outsiders: number[] = [];

  async function init() {
    const admin = await base.init();
    outsiders = (
      await db()
        .insert(clubs)
        .values(Array.from({ length: 6 }, (_, i) => ({ name: `Clube de fora ${i + 1} (recompra)` })))
        .returning({ id: clubs.id })
    ).map((r) => r.id);
    return admin;
  }

  const idOf = (side: Side): number => (/^out\d$/.test(side) ? outsiders[Number(side.slice(3))]! : base.club(side));

  type MatchInsert = typeof matches.$inferInsert;
  const match = (seasonId: number, competition: string, stage: { round?: number; phase?: string }, spec: FinalSpec, end: Date): MatchInsert => ({
    seasonId,
    competition,
    round: stage.round ?? null,
    phase: stage.phase ?? null,
    homeClubId: idOf(spec.home),
    awayClubId: idOf(spec.away),
    kickoff: new Date(end.getTime() - 120 * 60_000),
    finishedAt: spec.score ? end : null,
    homeGoals: spec.score ? spec.score[0] : null,
    awayGoals: spec.score ? spec.score[1] : null,
    status: spec.score ? "finished" : "scheduled",
  });

  /** O título de uma copa da temporada, em centavos. */
  async function setTitle(s: Season, competition: string, perShare: number) {
    await db()
      .update(cupPhases)
      .set({ perShare })
      .where(and(eq(cupPhases.seasonId, s.seasonId), eq(cupPhases.competition, competition), eq(cupPhases.variant, "title")));
  }

  /** As cinco competições da temporada, com os valores dos critérios. Devolve o id de cada jogo. */
  async function seasonEnd(s: Season, spec: EndSpec = {}): Promise<EndMatches> {
    const cdb = spec.cdb ?? { home: "FLA3", away: "out3", score: [1, 0] };
    const lib = spec.lib ?? { home: "PAL3", away: "out1", score: [2, 0] };
    const sula = spec.sula ?? { home: "SAO3", away: "out2", score: [1, 0] };
    const titles = { ...TITLES, ...spec.titles };
    if (titles.cdb !== null) await setTitle(s, "copa-do-brasil", titles.cdb);
    if (titles.lib !== null) await setTitle(s, "libertadores", titles.lib);
    if (titles.sula !== null) await setTitle(s, "sulamericana", titles.sula);
    const greB = spec.greB ?? true;
    await db().update(seasonRules).set({ bPerPoint: 275 }).where(eq(seasonRules.seasonId, s.seasonId));
    const rows = await db()
      .insert(matches)
      .values([
        match(s.seasonId, "brasileirao-b", { round: 1 }, greB ? { home: "GRE3", away: "out0", score: [1, 1] } : { home: "out4", away: "out5", score: [1, 1] }, B_END),
        match(s.seasonId, "sulamericana", { phase: "final" }, sula, SULA_END),
        match(s.seasonId, "libertadores", { phase: "final" }, lib, LIB_END),
        match(s.seasonId, "brasileirao-a", { round: 1 }, { home: "JUV3", away: "RBB3", score: [1, 1] }, A_END),
        match(s.seasonId, "copa-do-brasil", { phase: "final" }, cdb, FINAL_END),
      ])
      .returning({ id: matches.id });
    if (greB) {
      // a classificação oficial da B, já conferida: GRE3 em 3º, com os clubes de fora em volta
      const order = ["out1", "out2", "GRE3", "out3"];
      await db()
        .insert(standings)
        .values(order.map((side, i) => ({ seasonId: s.seasonId, competition: "brasileirao-b", clubId: idOf(side), position: i + 1, points: 10 - i, confirmedAt: B_END })));
    }
    const [b, sulaId, libId, a, cdbId] = rows.map((r) => r.id);
    return { cdb: cdbId!, lib: libId!, sula: sulaId!, a: a!, b: b! };
  }

  /** O placar da final da Copa do Brasil chega (o fim às 18h de Brasília). */
  async function registerFinal(m: EndMatches, score: [number, number], end: Date = FINAL_END) {
    await db().update(matches).set({ status: "finished", homeGoals: score[0], awayGoals: score[1], finishedAt: end }).where(eq(matches.id, m.cdb));
  }

  /** Compra da tesouraria a um preço dado (centavos), no instante dado. */
  async function buyAt(s: Season, walletId: number, ticker: string, shares: number, price: number, when: Date) {
    await withTransaction(db(), async (tx) => {
      await lockWallets(tx, [s.treasury, walletId]);
      await post(tx, { walletId: s.treasury, at: when, kind: "trade", clubId: base.club(ticker), sharesDelta: -shares, cashDelta: shares * price, price, costBasis: "sale" });
      await post(tx, { walletId, at: when, kind: "trade", clubId: base.club(ticker), sharesDelta: shares, cashDelta: -shares * price, price, costBasis: "purchase" });
    });
  }

  /**
   * A conta excluída como a F5 a encerra: a conta passa a `deleted` e as ações vão para a tesouraria (linhas
   * `account_deleted`); o caixa some.
   */
  async function deleteAccount(s: Season, walletId: number, when: Date) {
    const [w] = await db().select().from(wallets).where(eq(wallets.id, walletId));
    await db().update(users).set({ status: "deleted" }).where(eq(users.id, w!.userId!));
    const held = await db().select().from(positions).where(eq(positions.walletId, walletId));
    await withTransaction(db(), async (tx) => {
      await lockWallets(tx, [walletId, s.treasury]);
      const ref = { type: "account_deleted", id: walletId };
      for (const p of held.filter((x) => x.shares > 0)) {
        await post(tx, { walletId, at: when, kind: "account_deleted", clubId: p.clubId, sharesDelta: -p.shares, costBasis: "debit", ref });
        await post(tx, { walletId: s.treasury, at: when, kind: "account_deleted", clubId: p.clubId, sharesDelta: p.shares, costBasis: "purchase", price: 100, ref });
      }
      const [now] = await tx.db.select().from(wallets).where(eq(wallets.id, walletId));
      if (now!.cash !== 0) await post(tx, { walletId, at: when, kind: "account_deleted", cashDelta: -now!.cash, ref });
    });
  }

  /** O patrimônio de cada carteira (sem a tesouraria) no instante. */
  const equityAt = (s: Season, when: Date) => withTransaction(db(), (tx) => EquityAt.forSeason(tx, s.seasonId, when));

  const seasonOf = async (s: Season) => (await db().select().from(seasons).where(eq(seasons.id, s.seasonId)))[0]!;

  /** Os eventos de recompra da temporada (todas as versões), em ordem de id. */
  const buybacksOf = (s: Season) =>
    db().select().from(payoutEvents).where(and(eq(payoutEvents.seasonId, s.seasonId), eq(payoutEvents.kind, "buyback"))).orderBy(asc(payoutEvents.id));

  /** A versão vigente da recompra de um clube. */
  const buybackOf = async (s: Season, ticker: string) =>
    (await buybacksOf(s)).find((e) => e.clubId === base.club(ticker) && e.status !== "superseded")!;

  /** As ações do clube na carteira (0 sem a linha). */
  const sharesOf = async (walletId: number, ticker: string) =>
    (await db().select().from(positions).where(and(eq(positions.walletId, walletId), eq(positions.clubId, base.club(ticker)))))[0]?.shares ?? 0;

  const positionOf = async (walletId: number, ticker: string) =>
    (await db().select().from(positions).where(and(eq(positions.walletId, walletId), eq(positions.clubId, base.club(ticker)))))[0];

  return {
    ...base,
    init,
    idOf,
    setTitle,
    seasonEnd,
    registerFinal,
    buyAt,
    deleteAccount,
    equityAt,
    seasonOf,
    buybacksOf,
    buybackOf,
    sharesOf,
    positionOf,
    // o espalhar de `base` lê o `admin` antes do `init`: o getter volta aqui
    get admin() {
      return base.admin;
    },
  };
}
