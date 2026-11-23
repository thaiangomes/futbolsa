import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  BRASILEIRAO_A,
  BRASILEIRAO_B,
  finishTime,
  roundCloseTimes,
  type CupRules,
  type Match,
  type SeasonValues,
} from "@futbolsa/engine";
import { Exchange } from "../../../../packages/engine/src/engine/orderbook.js";
import { Ledger } from "../../../../packages/engine/src/engine/ledger.js";
import { MarketView } from "../../../../packages/engine/src/sim/market.js";
import { fairValuesAt, type FairValueData } from "../../src/modules/market/index.js";
import { leagueViewsAt } from "../../src/modules/market/maker/fair-value.js";

// T9 do Plano do livro de ofertas e formador: o valor justo montado dos jogos, da classificação e dos valores da temporada,
// conferido contra o `MarketView.fairValue` da simulação calibrada.

const CLUBS = ["FLA3", "PAL3", "SPT3", "COR3"] as const;
const iso = (s: string) => new Date(s).toISOString();
const ms = (s: string) => Date.parse(s);

/** Dois jogos por rodada (turno e returno entre quatro clubes = 6 rodadas), sem resultado. */
function league(): Match[] {
  const pairs: [string, string][][] = [
    [["FLA3", "PAL3"], ["SPT3", "COR3"]],
    [["FLA3", "SPT3"], ["PAL3", "COR3"]],
    [["FLA3", "COR3"], ["PAL3", "SPT3"]],
  ];
  const out: Match[] = [];
  let id = 1;
  for (let r = 1; r <= 6; r++) {
    const kickoff = new Date(Date.UTC(2027, 3, 12 + (r - 1) * 7, 21)).toISOString(); // uma rodada por semana, a partir de 2027-04-12
    for (const [home, away] of pairs[(r - 1) % 3]!) {
      const [h, a] = r > 3 ? [away, home] : [home, away];
      out.push({
        id: String(id++),
        competition: "brasileirao-a",
        round: r,
        kickoff,
        home: h,
        away: a,
        homeGoals: null,
        awayGoals: null,
        status: "scheduled",
      });
    }
  }
  return out;
}

const finish = (m: Match, homeGoals: number, awayGoals: number, finishedAt?: string): Match => ({
  ...m,
  homeGoals,
  awayGoals,
  status: "finished",
  ...(finishedAt ? { finishedAt: iso(finishedAt) } : {}),
});

const VALUES: SeasonValues = { leagues: { "brasileirao-a": BRASILEIRAO_A, "brasileirao-b": BRASILEIRAO_B }, cups: {} };

const data = (matches: Match[], over: Partial<FairValueData> = {}): FairValueData => ({
  matches,
  officialStandings: {},
  values: VALUES,
  listed: new Map(CLUBS.map((c) => [c, "A" as const])),
  buybackMultiple: 1.5,
  ...over,
});

describe("valor justo (puro)", () => {
  it("livro 28: com a rodada 5 fechada às 20h e não aprovada, o valor justo cai R$ 0,30 às 20h", () => {
    // uma rodada só: o FLA3 vence às 18h (3 pontos) e o outro jogo termina às 20h, quando a rodada fecha
    const [a, b] = league();
    const matches = [finish(a!, 3, 0, "2027-04-12T21:00:00Z"), finish(b!, 1, 1, "2027-04-12T23:00:00Z"), ...league().slice(2)];
    const d = data(matches, { buybackMultiple: 0 });
    const before = fairValuesAt(d, ms("2027-04-12T22:59:59Z")).get("FLA3")!;
    const after = fairValuesAt(d, ms("2027-04-12T23:00:00Z")).get("FLA3")!;
    expect(before - after).toBe(30);
    // a rodada 1 fechou às 23h (fim do último jogo): conferência independente do instante
    expect(roundCloseTimes(matches).get(1)).toBe(ms("2027-04-12T23:00:00Z"));
  });

  it("a recompra esperada entra como o múltiplo vezes os dividendos projetados da temporada", () => {
    const semRecompra = fairValuesAt(data(league(), { buybackMultiple: 0 }), ms("2027-04-01T00:00:00Z")).get("FLA3")!;
    const comRecompra = fairValuesAt(data(league(), { buybackMultiple: 1.5 }), ms("2027-04-01T00:00:00Z")).get("FLA3")!;
    expect(comRecompra).toBeGreaterThan(semRecompra * 2);
  });

  it("é igual ao MarketView.fairValue da simulação, nos mesmos jogos e valores (antes, durante e depois de rodadas fechadas)", () => {
    const all = league();
    // resultados das duas primeiras rodadas e de um jogo da terceira
    const results: [number, number][] = [[2, 0], [1, 1], [0, 1], [3, 2], [1, 0]];
    const matches = all.map((m, i) => (i < results.length ? finish(m, results[i]![0], results[i]![1]) : m));
    const instants = [
      "2027-04-01T00:00:00Z", // antes de qualquer jogo
      "2027-04-13T12:00:00Z", // depois da rodada 1
      "2027-04-20T12:00:00Z", // depois da rodada 2
      "2027-04-27T23:30:00Z", // no meio da rodada 3 (um jogo encerrado, a rodada ainda não fechou)
    ];
    for (const when of instants) {
      const now = ms(when);
      // a foto dos jogos no instante: o que ainda não terminou nele aparece sem resultado, como no banco
      const snap = matches.map((m): Match => (m.status === "finished" && finishTime(m) > now ? { ...m, status: "scheduled", homeGoals: null, awayGoals: null } : m));
      const mine = fairValuesAt(data(snap), now);
      // a simulação conhece os jogos encerrados até o instante e paga os pontos das rodadas fechadas
      const known = snap.filter((m) => m.status === "finished");
      const view = new MarketView(new Exchange(new Ledger()), new Ledger(), [...CLUBS], BRASILEIRAO_A, all);
      view.now = now;
      view.buybackMultiple = 1.5;
      view.setKnownMatches(known);
      const closes = roundCloseTimes(snap);
      for (const club of CLUBS) {
        const paid = snap
          .filter((m) => m.status === "finished" && (m.home === club || m.away === club) && (closes.get(m.round!) ?? Infinity) <= now)
          .reduce((sum, m) => sum + (m.homeGoals! === m.awayGoals! ? 1 : (m.home === club ? m.homeGoals! > m.awayGoals! : m.awayGoals! > m.homeGoals!) ? 3 : 0), 0);
        view.paidPoints.set(club, paid);
      }
      for (const club of CLUBS) expect(mine.get(club), `${club} em ${when}`).toBe(view.fairValue(club));
    }
  });

  it("copas: o valor justo inclui o que a copa ainda pode pagar, como o MarketView.setCups", () => {
    const cup: CupRules = { phases: ["quartas", "semifinal", "final"], advance: { quartas: 250, semifinal: 400 }, title: 800 };
    const cupMatches: Match[] = [
      { id: "c1", competition: "copa-do-brasil", phase: "quartas", kickoff: iso("2027-05-05T21:00:00Z"), home: "FLA3", away: "PAL3", homeGoals: null, awayGoals: null, status: "scheduled" },
      { id: "c2", competition: "copa-do-brasil", phase: "semifinal", kickoff: iso("2027-05-19T21:00:00Z"), home: "FLA3", away: "SPT3", homeGoals: null, awayGoals: null, status: "scheduled" },
    ];
    const values: SeasonValues = { ...VALUES, cups: { "copa-do-brasil": cup } };
    const all = [...league(), ...cupMatches];
    const now = ms("2027-04-01T00:00:00Z");
    const mine = fairValuesAt(data(all, { values }), now);
    const view = new MarketView(new Exchange(new Ledger()), new Ledger(), [...CLUBS], BRASILEIRAO_A, league());
    view.now = now;
    view.buybackMultiple = 1.5;
    view.setCups([{ matches: cupMatches, rules: cup }]);
    for (const club of CLUBS) expect(mine.get(club), club).toBe(view.fairValue(club));
    // e o clube que está na copa vale mais que o que não está
    const semCopa = fairValuesAt(data(league()), now);
    expect(mine.get("FLA3")!).toBeGreaterThan(semCopa.get("FLA3")!);
    expect(mine.get("COR3")).toBe(semCopa.get("COR3"));
  });

  it("vagas e copas: o placar de um jogo de copa mexe no valor justo dos bots, mas não no da casa", () => {
    const cup: CupRules = { phases: ["quartas", "semifinal", "final"], advance: { quartas: 250, semifinal: 400 }, title: 800 };
    const cupMatches: Match[] = [
      { id: "c1", competition: "copa-do-brasil", phase: "quartas", kickoff: iso("2027-05-05T21:00:00Z"), home: "FLA3", away: "PAL3", homeGoals: null, awayGoals: null, status: "scheduled" },
    ];
    const values: SeasonValues = { ...VALUES, cups: { "copa-do-brasil": cup } };
    const d = data([...league(), ...cupMatches], { values });
    const now = ms("2027-05-05T22:30:00Z"); // 1h30 depois do apito
    const casaAntes = fairValuesAt(d, now);
    const sem = leagueViewsAt(d, now);
    const com = leagueViewsAt(d, now);
    for (const v of new Set(com.values())) v.setLive([{ home: "FLA3", away: "PAL3", homeGoals: 2, awayGoals: 0, minute: 80 }]);
    // os bots: o FLA3 que vence por 2 a 0 aos 80 minutos vale mais, e o PAL3 vale menos
    expect(com.get("FLA3")!.fairValue("FLA3")).toBeGreaterThan(sem.get("FLA3")!.fairValue("FLA3"));
    expect(com.get("PAL3")!.fairValue("PAL3")).toBeLessThan(sem.get("PAL3")!.fairValue("PAL3"));
    // a casa só conhece o resultado final: nada mudou
    expect(fairValuesAt(d, now)).toEqual(casaAntes);
  });

  it("clube da Série B usa as regras da B (R$ 0,05 por ponto)", () => {
    const b: Match[] = [
      { id: "b1", competition: "brasileirao-b", round: 1, kickoff: iso("2027-04-12T21:00:00Z"), home: "SPT3", away: "EXT-9", homeGoals: null, awayGoals: null, status: "scheduled" },
      { id: "b2", competition: "brasileirao-b", round: 2, kickoff: iso("2027-04-19T21:00:00Z"), home: "EXT-9", away: "SPT3", homeGoals: null, awayGoals: null, status: "scheduled" },
    ];
    const listed = new Map([["FLA3", "A" as const], ["PAL3", "A" as const], ["SPT3", "B" as const], ["COR3", "A" as const]]);
    const fair = fairValuesAt(data([...league(), ...b], { listed }), ms("2027-04-01T00:00:00Z"));
    const cheap = fair.get("SPT3")!;
    expect(cheap).toBeGreaterThan(0);
    expect(cheap).toBeLessThan(fair.get("FLA3")!);
  });

  it("copa sem tabela confirmada é erro claro", () => {
    const cupMatches: Match[] = [
      { id: "c1", competition: "libertadores", phase: "grupos", kickoff: iso("2027-05-05T21:00:00Z"), home: "FLA3", away: "PAL3", homeGoals: null, awayGoals: null, status: "scheduled" },
    ];
    expect(() => fairValuesAt(data([...league(), ...cupMatches]), ms("2027-04-01T00:00:00Z"))).toThrow(/libertadores/);
  });
});

// O serviço lê o banco e entrega a mesma conta.
import { beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { seasons } from "../../src/infra/db/schema/index.js";
import { withTransaction } from "../../src/infra/db/index.js";
import { FairValueService } from "../../src/modules/market/index.js";
import { SeasonValuesService } from "../../src/modules/dividends/season-values/season-values.service.js";
import { useTestDatabase } from "../support/db.js";
import { insertMatch, marketSeason, type MarketSeason } from "./helpers.js";

describe("valor justo (banco)", () => {
  const t = useTestDatabase(6);
  let s: MarketSeason;
  let service: FairValueService;

  beforeAll(async () => {
    s = await marketSeason(t.db);
    const values = new SeasonValuesService(t.db);
    await withTransaction(t.db, (tx) => values.createInitial(tx, s.seasonId));
    service = new FairValueService(t.db, values);
    await t.db.update(seasons).set({ status: "trading" }).where(eq(seasons.id, s.seasonId));
    const id = (ticker: string) => s.clubIds.get(ticker)!;
    await insertMatch(t.db, { seasonId: s.seasonId, homeClubId: id("FLA3"), awayClubId: id("PAL3"), kickoff: new Date("2027-04-12T21:00:00Z") });
    await insertMatch(t.db, { seasonId: s.seasonId, homeClubId: id("SPT3"), awayClubId: id("COR3"), kickoff: new Date("2027-04-12T21:00:00Z") });
    await insertMatch(t.db, { seasonId: s.seasonId, homeClubId: id("PAL3"), awayClubId: id("FLA3"), kickoff: new Date("2027-04-19T21:00:00Z"), round: 2 });
    await insertMatch(t.db, { seasonId: s.seasonId, homeClubId: id("COR3"), awayClubId: id("SPT3"), kickoff: new Date("2027-04-19T21:00:00Z"), round: 2 });
  });

  it("devolve um valor justo positivo para cada clube listado, igual ao da função pura sobre os mesmos dados", async () => {
    const now = new Date("2027-04-01T12:00:00Z");
    const fair = await service.compute(s.seasonId, now);
    expect([...fair.keys()].sort()).toEqual(["COR3", "FLA3", "PAL3", "SPT3"]);
    for (const v of fair.values()) expect(v).toBeGreaterThan(0);
    const data = await service.load(s.seasonId);
    expect(data.buybackMultiple).toBe(1.5);
    expect(data.matches).toHaveLength(4);
    expect(fairValuesAt(data, now.getTime())).toEqual(fair);
  });

  it("jogo encerrado e fechado muda o valor justo do clube que pontuou", async () => {
    const before = await service.compute(s.seasonId, new Date("2027-04-12T22:00:00Z"));
    const id = (ticker: string) => s.clubIds.get(ticker)!;
    await t.db.execute(
      sql`update futbolsa.matches set status = 'finished', home_goals = 2, away_goals = 0, finished_at = '2027-04-12T23:00:00Z' where home_club_id in (${id("FLA3")}, ${id("SPT3")}) and round = 1`,
    );
    const after = await service.compute(s.seasonId, new Date("2027-04-13T12:00:00Z"));
    // a vitória de 2 a 0 já fechou (rodada 1 inteira terminou às 23h): o FLA3 ganhou 3 pontos esperados no jogo que faltava, mas os 3 pontos
    // já fechados saem do "a receber"; o que importa aqui é que o valor justo foi refeito com os jogos do banco
    expect(after.get("FLA3")).not.toBe(before.get("FLA3"));
  });
});
