import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BRASILEIRAO_A,
  computeStandings,
  scheduleBuyback,
  scheduleLeaguePayouts,
} from "../src/engine/dividends.js";
import { buybackCloseTime, buybackEvents, buybackPerShare } from "../src/engine/buyback.js";
import { receivable, equity } from "../src/engine/equity.js";
import { reais } from "../src/engine/money.js";
import { eventsFor, type PayoutEvent } from "../src/engine/payoutEvents.js";
import type { Match } from "../src/engine/types.js";

const at = (iso: string) => Date.parse(iso);
const MULTIPLO = 15_000; // 1,5×

function evento(clubId: string, perShare: number, closedAt: number, kind: PayoutEvent["kind"] = "points"): PayoutEvent {
  return {
    key: `${kind}|x|${closedAt}|${clubId}`,
    kind,
    clubId,
    competition: "brasileirao-a",
    stage: "1",
    perShare,
    closedAt,
    reason: "teste",
  };
}

describe("buybackPerShare", () => {
  it("dividendos 17: R$ 39,40 pagos dão recompra de R$ 59,10 por ação", () => {
    expect(buybackPerShare(reais(39.4), MULTIPLO)).toBe(reais(59.1));
  });

  it("dividendos 18: R$ 5,55 pagos dão R$ 8,33 (R$ 8,325 arredondado para cima)", () => {
    expect(buybackPerShare(reais(5.55), MULTIPLO)).toBe(reais(8.33));
  });

  it("dividendos 23: R$ 4,75 (2,75 de pontos + 2,00 de acesso) dão R$ 7,13 (R$ 7,125 para cima)", () => {
    expect(buybackPerShare(reais(2.75) + reais(2), MULTIPLO)).toBe(reais(7.13));
  });

  it("clube que não pagou nada tem recompra de R$ 0,00", () => {
    expect(buybackPerShare(0, MULTIPLO)).toBe(0);
  });

  it("múltiplo zero dá zero e múltiplos em pontos-base cobrem frações (1,15× em 11.500)", () => {
    expect(buybackPerShare(1_000, 0)).toBe(0);
    expect(buybackPerShare(1_000, 11_500)).toBe(1_150);
  });

  it("recusa total negativo ou não inteiro e múltiplo negativo ou não inteiro", () => {
    expect(() => buybackPerShare(-1, MULTIPLO)).toThrow();
    expect(() => buybackPerShare(10.5, MULTIPLO)).toThrow();
    expect(() => buybackPerShare(10, -1)).toThrow();
    expect(() => buybackPerShare(10, 1.5)).toThrow();
  });
});

describe("buybackCloseTime", () => {
  it("dividendos 19: com a Série A fechada em 2027-12-05 e a Copa do Brasil aberta não há instante", () => {
    expect(buybackCloseTime({ "brasileirao-a": at("2027-12-05T18:00:00-03:00"), "copa-do-brasil": undefined })).toBeUndefined();
  });

  it("dividendos 19: quando a final termina, o instante é o do apito final", () => {
    const final = at("2027-12-19T23:30:00-03:00");
    expect(buybackCloseTime({ "brasileirao-a": at("2027-12-05T18:00:00-03:00"), "copa-do-brasil": final })).toBe(final);
  });

  it("o último dos fechamentos vale, em qualquer ordem", () => {
    const a = at("2027-12-19T23:30:00-03:00");
    const b = at("2027-11-01T20:00:00-03:00");
    expect(buybackCloseTime({ x: b, y: a })).toBe(a);
    expect(buybackCloseTime({ y: a, x: b })).toBe(a);
  });

  it("sem nenhuma competição não há instante", () => {
    expect(buybackCloseTime({})).toBeUndefined();
  });
});

describe("buybackEvents", () => {
  const fechamento = at("2027-12-19T23:30:00-03:00");
  const listados = new Set(["FLA3", "GRE3", "PAL3"]);

  it("dividendos 17: um evento por clube listado com 1,5× a soma de todas as competições, no mesmo instante", () => {
    const eventos = [
      evento("FLA3", reais(7.9), at("2027-06-01T20:00:00-03:00")),
      evento("FLA3", reais(5), at("2027-12-05T18:00:00-03:00"), "placement"),
      evento("FLA3", reais(26.5), at("2027-11-01T20:00:00-03:00"), "cup_phase"),
    ];
    const r = buybackEvents(eventos, listados, MULTIPLO, fechamento);
    const fla = r.find((e) => e.clubId === "FLA3")!;
    expect(fla).toMatchObject({ kind: "buyback", perShare: reais(59.1), closedAt: fechamento, competition: "temporada" });
    expect(r.map((e) => e.closedAt)).toEqual([fechamento, fechamento, fechamento]);
  });

  it("dividendos 24: clube listado que não pagou nada tem evento de R$ 0,00", () => {
    const r = buybackEvents([evento("FLA3", 100, at("2027-06-01T20:00:00-03:00"))], listados, MULTIPLO, fechamento);
    expect(r.map((e) => [e.clubId, e.perShare])).toEqual([
      ["FLA3", 150],
      ["GRE3", 0],
      ["PAL3", 0],
    ]);
  });

  it("clube não listado não ganha evento de recompra", () => {
    const r = buybackEvents([evento("ZZZ9", 100, at("2027-06-01T20:00:00-03:00"))], listados, MULTIPLO, fechamento);
    expect(r.some((e) => e.clubId === "ZZZ9")).toBe(false);
  });

  it("o evento de recompra anterior não entra na soma (recalcular não compõe sobre si mesmo)", () => {
    const anterior = evento("FLA3", 9_999, fechamento, "buyback");
    const r = buybackEvents([evento("FLA3", 100, at("2027-06-01T20:00:00-03:00")), anterior], listados, MULTIPLO, fechamento);
    expect(r.find((e) => e.clubId === "FLA3")!.perShare).toBe(150);
  });

  it("a chave é estável entre versões e o motivo diz o múltiplo", () => {
    const [a] = buybackEvents([evento("FLA3", 100, at("2027-06-01T20:00:00-03:00"))], new Set(["FLA3"]), MULTIPLO, fechamento);
    const [b] = buybackEvents([evento("FLA3", 200, at("2027-06-01T20:00:00-03:00"))], new Set(["FLA3"]), MULTIPLO, fechamento);
    expect(a!.key).toBe(b!.key);
    expect(a!.reason).toContain("1,5×");
  });

  it("recusa fechamento da recompra anterior ao de algum evento", () => {
    expect(() =>
      buybackEvents([evento("FLA3", 100, fechamento + 1)], listados, MULTIPLO, fechamento),
    ).toThrow();
  });

  it("rankings 23: 1.000 FLA3 com recompra de R$ 59,10 dão R$ 59.100,00 a receber e o patrimônio não muda na aprovação", () => {
    const [fla] = buybackEvents([evento("FLA3", reais(39.4), at("2027-06-01T20:00:00-03:00"))], new Set(["FLA3"]), MULTIPLO, fechamento);
    const devido = { closedAt: fla!.closedAt, perShare: fla!.perShare, shares: 1_000, credited: 0 };
    const aReceber = receivable(fechamento, [devido]);
    expect(aReceber).toBe(reais(59_100));
    const antes = equity({ cash: reais(1_000), positions: [{ shares: 1_000, price: reais(60) }], receivable: aReceber, buybackClosed: true });
    const depois = equity({
      cash: reais(1_000) + aReceber,
      positions: [],
      receivable: receivable(fechamento, [{ ...devido, credited: aReceber }]),
      buybackClosed: true,
    });
    expect(antes).toBe(reais(60_100));
    expect(depois).toBe(antes);
  });
});

describe("regressão: recompra × scheduleBuyback da simulação, com o Brasileirão de 2025", () => {
  it("dá o mesmo valor por ação em todos os clubes", () => {
    const file = JSON.parse(readFileSync("data/brasileirao-2025.json", "utf8")) as { matches: Match[]; clubs: { id: string }[] };
    const listed = new Set(file.clubs.map((c) => c.id));
    const standings = { "brasileirao-a": computeStandings(file.matches).map((r) => r.clubId) };
    const { events, closes } = eventsFor({
      matches: file.matches,
      standings,
      values: { leagues: { "brasileirao-a": BRASILEIRAO_A }, cups: {} },
      listed,
    });
    const instante = buybackCloseTime(closes)!;
    const novo = buybackEvents(events, listed, MULTIPLO, instante);
    const antigo = scheduleBuyback(scheduleLeaguePayouts(file.matches, BRASILEIRAO_A), 1.5);
    const mapa = Object.fromEntries(antigo.map((p) => [p.clubId, p.perShare]));
    for (const e of novo) expect(e.perShare).toBe(mapa[e.clubId] ?? 0);
    expect(novo.length).toBe(listed.size);
  });
});
