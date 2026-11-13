import { describe, expect, it } from "vitest";
import { entryQuote, entryWindow, referencePrice } from "../src/engine/entry.js";
import { eventsFor } from "../src/engine/payoutEvents.js";
import { leagueClosedAt } from "../src/engine/payoutEvents.js";
import { reais } from "../src/engine/money.js";
import type { Match } from "../src/engine/types.js";

const t = (iso: string) => Date.parse(iso);
let id = 1;
function game(round: number, kickoff: string, score: [number, number] | null, extra: Partial<Match> = {}): Match {
  return {
    id: `m${id++}`,
    competition: "brasileirao-a",
    round,
    kickoff,
    home: "FLA3",
    away: "PAL3",
    homeGoals: score ? score[0] : null,
    awayGoals: score ? score[1] : null,
    status: score ? "finished" : "scheduled",
    ...extra,
  };
}

/** 22 preços que somam R$ 520,00 (critério 1): 20 × R$ 24,00 + 2 × R$ 20,00. */
function prices(values: number[]): Record<string, number> {
  return Object.fromEntries(values.map((v, i) => [`C${String(i).padStart(2, "0")}3`, v]));
}

describe("entryWindow (entrada 4 e 12)", () => {
  const done = [game(1, "2027-04-10T20:00:00-03:00", [1, 0]), game(2, "2027-04-17T20:00:00-03:00", [0, 0])];

  it("entrada 12: com todos os jogos encerrados a janela está fechada, no fim do último jogo", () => {
    const w = entryWindow(done, t("2027-12-10T00:00:00Z"));
    expect(w.state).toBe("closed");
    expect(w.closedAt).toBe(leagueClosedAt(done));
  });

  it("entrada 4: com jogo por disputar a janela está aberta", () => {
    const ms = [...done, game(3, "2027-04-24T20:00:00-03:00", null)];
    expect(entryWindow(ms, t("2027-04-20T00:00:00Z"))).toEqual({ state: "open" });
  });

  it("jogo adiado ainda por disputar mantém a janela aberta depois da última rodada", () => {
    const ms = [...done, game(1, "2027-04-10T20:00:00-03:00", null, { postponed: true, home: "SAO3", away: "COR3" })];
    expect(entryWindow(ms, t("2027-12-10T00:00:00Z")).state).toBe("open");
  });

  it("o adiado disputado depois da última rodada fecha a janela no fim dele", () => {
    const late = game(1, "2027-05-02T20:00:00-03:00", [2, 1], { postponed: true, home: "SAO3", away: "COR3" });
    const w = entryWindow([...done, late], t("2027-12-10T00:00:00Z"));
    expect(w.closedAt).toBe(t("2027-05-02T22:00:00-03:00"));
  });

  it("antes do instante de fechamento a janela ainda está aberta", () => {
    const closedAt = leagueClosedAt(done)!;
    expect(entryWindow(done, closedAt - 1).state).toBe("open");
    expect(entryWindow(done, closedAt).state).toBe("closed");
  });

  it("só a Série A conta, e sem jogos dela não há fim conhecido", () => {
    const copa = game(1, "2027-04-10T20:00:00-03:00", [1, 0], { competition: "copa-do-brasil" });
    expect(entryWindow([copa], t("2027-12-10T00:00:00Z")).state).toBe("not_scheduled");
    expect(entryWindow([], 0).state).toBe("not_scheduled");
  });
});

describe("leagueClosedAt", () => {
  it("é o closedAt que eventsFor usa para a competição", () => {
    const ms = [
      game(1, "2027-04-10T20:00:00-03:00", [1, 0]),
      game(1, "2027-05-02T20:00:00-03:00", [2, 1], { postponed: true, home: "SAO3", away: "COR3" }),
    ];
    const values = {
      leagues: { "brasileirao-a": { perPoint: 10, placement: [] as number[] } },
      cups: {},
    } as never;
    const { closes } = eventsFor({ matches: ms, standings: {}, values, listed: new Set(["FLA3", "PAL3", "SAO3", "COR3"]) });
    expect(closes["brasileirao-a"]).toBe(leagueClosedAt(ms));
  });

  it("sem jogos ou com jogo por disputar é indefinido", () => {
    expect(leagueClosedAt([])).toBeUndefined();
    expect(leagueClosedAt([game(1, "2027-04-10T20:00:00-03:00", null)])).toBeUndefined();
  });
});

describe("referencePrice (entrada 5 e 6)", () => {
  it("entrada 5: o último negócio vale como referência", () => {
    expect(referencePrice({ lastPrice: reais(44), ipoPrice: reais(40) })).toBe(reais(44));
  });
  it("entrada 6: sem negócio, o preço do IPO", () => {
    expect(referencePrice({ lastPrice: null, ipoPrice: reais(40) })).toBe(reais(40));
  });
  it("sem nenhum dos dois é erro", () => {
    expect(() => referencePrice({ lastPrice: null, ipoPrice: null })).toThrow();
  });
});

describe("entryQuote (entrada 1, 4, 7 e 16)", () => {
  it("entrada 1: 22 preços que somam R$ 520,00 dão 134 ações de cada e R$ 30.320,00 em caixa", () => {
    const q = entryQuote(prices([...Array(20).fill(reais(24)), reais(20), reais(20)]));
    expect(q.sum).toBe(reais(520));
    expect(q.n).toBe(134);
    expect(q.cash).toBe(reais(30_320));
    expect(q.stockValue + q.cash).toBe(reais(100_000));
    expect(q.clubCount).toBe(22);
    expect(q.clubs.every((c) => c.shares === 134)).toBe(true);
  });

  it("entrada 4: soma de R$ 457,30 dá 153 ações e R$ 30.033,10 em caixa", () => {
    // 21 × R$ 20,80 = 436,80 + R$ 20,50
    const q = entryQuote(prices([...Array(21).fill(reais(20.8)), reais(20.5)]));
    expect(q.sum).toBe(reais(457.3));
    expect(q.n).toBe(153);
    expect(q.cash).toBe(reais(30_033.1));
  });

  it("entrada 7: o clube no piso de R$ 0,50 entra na soma e recebe N", () => {
    const q = entryQuote({ AAA3: reais(0.5), BBB3: reais(49.5) });
    expect(q.sum).toBe(reais(50));
    expect(q.clubs.find((c) => c.ticker === "AAA3")).toEqual({ ticker: "AAA3", price: reais(0.5), shares: 1400 });
  });

  it("entrada 16: soma acima de R$ 70.000,00 dá n = 0 e todo o caixa", () => {
    const q = entryQuote({ AAA3: reais(40_000), BBB3: reais(30_001) });
    expect(q.n).toBe(0);
    expect(q.cash).toBe(reais(100_000));
    expect(q.stockValue).toBe(0);
  });

  it("as linhas saem em ordem de ticker e preço abaixo do piso é erro", () => {
    expect(entryQuote({ ZZZ3: 5000, AAA3: 5000 }).clubs.map((c) => c.ticker)).toEqual(["AAA3", "ZZZ3"]);
    expect(() => entryQuote({ AAA3: 49 })).toThrow();
  });
});
