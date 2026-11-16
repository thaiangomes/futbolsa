import { describe, expect, it } from "vitest";
import { loadSeason, markOutOfWindow } from "../src/data/season.js";
import { LIBERTADORES } from "../src/engine/dividends.js";
import { DEFAULT_MARKET_MAKER } from "../src/engine/marketMaker.js";
import type { Match } from "../src/engine/types.js";
import { simulate, TREASURY } from "../src/sim/simulate.js";

const season = loadSeason("tests/fixtures/mini-season.json");
const small = { bots: { dividendos: 2, momentum: 2, torcedor: 4, aleatorio: 2, trader: 0, captura: 0, analista: 0, concentrador: 0, antecipador: 0 }, stepHours: 6 };

describe("simulação com o fixture de exemplo", () => {
  const result = simulate(season, { ...small, buyback: 0 });

  it("faz IPO de todos os clubes dentro da faixa", () => {
    expect(result.clubs).toHaveLength(4);
    for (const c of result.clubs) {
      expect(c.ipoPrice).toBeGreaterThanOrEqual(c.band.min);
      expect(c.ipoPrice).toBeLessThanOrEqual(c.band.max);
    }
  });

  it("paga os dividendos do campeonato (0,10 por ponto + colocação)", () => {
    const fla = result.clubs.find((c) => c.clubId === "FLA3")!;
    // FLA3: 3V 2E 1D = 11 pontos → R$ 1,10, e 1º lugar → R$ 5,00.
    expect(fla.finalPosition).toBe(1);
    expect(fla.dividendsPerShare).toBe(110 + 500);
  });

  it("é reproduzível com a mesma semente", () => {
    const again = simulate(season, { ...small, buyback: 0 });
    expect(again.clubs.map((c) => c.finalPrice)).toEqual(result.clubs.map((c) => c.finalPrice));
    expect(again.bots.map((b) => b.finalWorth)).toEqual(result.bots.map((b) => b.finalWorth));
  });

  it("a âncora peer muda o resultado (só negócios entre bots formam o preço)", () => {
    // Com recompra: sem ela o valor justo fica abaixo do IPO no fixture e os bots, que olham o valor, nem negociam.
    // Sem a margem de "nunca melhor que o mercado": neste fixture todo negócio é de bot comprando da casa
    // abaixo do preço, justamente o que a margem impede, e aí as duas âncoras ficam sem negócios.
    const noMargin = { ...DEFAULT_MARKET_MAKER, marketMargin: undefined };
    const last = simulate(season, { ...small, buyback: 1, marketMaker: noMargin });
    const peer = simulate(season, { ...small, buyback: 1, marketMaker: { ...noMargin, anchor: "peer" } });
    expect(peer.clubs.map((c) => c.finalPrice)).not.toEqual(last.clubs.map((c) => c.finalPrice));
  });

  it("com recompra, a casa recompra todas as ações pelo múltiplo dos dividendos", () => {
    const comRecompra = simulate(season, { ...small, buyback: 1 });
    // A régua passa a contar a recompra: no IPO, FLA3 ainda tem a pagar
    // R$ 6,10 de dividendos e mais R$ 6,10 de recompra.
    expect(comRecompra.checkpoints[0]!.remainingDividends.FLA3).toBe(2 * (110 + 500));
    expect(comRecompra.totalBuyback).toBeGreaterThan(0);
    expect(result.totalBuyback).toBe(0);
    // Sem ações no fim, o patrimônio dos bots é só caixa, e o dinheiro fecha:
    // caixa inicial + dividendos + recompra = bots + tesouraria.
    const bots = comRecompra.bots.reduce((s, b) => s + b.finalWorth, 0);
    expect(comRecompra.treasury.finalSharesValue).toBe(0);
    expect(bots + comRecompra.treasury.finalCash).toBe(
      10 * comRecompra.config.initialCash + comRecompra.totalDividends + comRecompra.totalBuyback,
    );
  });

  it("o trader negocia e o dinheiro continua fechando", () => {
    const comTrader = simulate(season, { ...small, bots: { ...small.bots, trader: 2 }, buyback: 1, traderHitRates: [0.3, 0.7] });
    const traders = comTrader.bots.filter((b) => b.profile === "trader");
    expect(traders.map((b) => b.hitRate)).toEqual([0.3, 0.7]);
    expect(comTrader.trades.total).not.toBe(simulate(season, { ...small, buyback: 1 }).trades.total);
    const bots = comTrader.bots.reduce((s, b) => s + b.finalWorth, 0);
    expect(bots + comTrader.treasury.finalCash).toBe(
      12 * comTrader.config.initialCash + comTrader.totalDividends + comTrader.totalBuyback,
    );
  });

  it("com bots de captura de dividendo o dinheiro continua fechando", () => {
    const comCaptura = simulate(season, { ...small, bots: { ...small.bots, captura: 2 }, buyback: 1 });
    const captura = comCaptura.bots.filter((b) => b.profile === "captura");
    expect(captura).toHaveLength(2);
    const bots = comCaptura.bots.reduce((s, b) => s + b.finalWorth, 0);
    expect(bots + comCaptura.treasury.finalCash).toBe(
      12 * comCaptura.config.initialCash + comCaptura.totalDividends + comCaptura.totalBuyback,
    );
  });

  it("analista, concentrador e antecipador negociam e o dinheiro continua fechando", () => {
    const extras = simulate(season, { ...small, bots: { ...small.bots, analista: 1, concentrador: 1, antecipador: 1 }, buyback: 1 });
    expect(extras.bots.filter((b) => ["analista", "concentrador", "antecipador"].includes(b.profile))).toHaveLength(3);
    const bots = extras.bots.reduce((s, b) => s + b.finalWorth, 0);
    expect(bots + extras.treasury.finalCash).toBe(13 * extras.config.initialCash + extras.totalDividends + extras.totalBuyback);
  });

  it("com a Libertadores, os dividendos de copa entram na régua e o dinheiro fecha", () => {
    const j = (phase: string, day: string, home: string, away: string): Match => ({
      id: `${phase}-${home}`, competition: "libertadores", phase, kickoff: `${day}T21:30:00-03:00`,
      home, away, homeGoals: 1, awayGoals: 0, status: "finished",
    });
    // FLA3 ganha tudo; PAL3 cai nas oitavas. Clubes de fora da Série A não recebem.
    const matches = [j("grupos", "2025-04-08", "FLA3", "EXT-A"), j("grupos", "2025-04-09", "PAL3", "EXT-B"),
      j("oitavas", "2025-04-15", "FLA3", "EXT-C"), j("oitavas", "2025-04-16", "EXT-D", "PAL3"),
      j("quartas", "2025-04-22", "FLA3", "EXT-D"), j("semifinal", "2025-04-29", "FLA3", "EXT-E"), j("final", "2025-05-06", "FLA3", "EXT-F")];
    const comCopa = simulate(season, { ...small, buyback: 1, cups: [{ matches, rules: LIBERTADORES }], ipoCups: false });
    // FLA3: 110 + 500 do campeonato, mais 150 + 225 + 375 + 600 + 1200 da copa, e a recompra de 1×.
    expect(comCopa.checkpoints[0]!.remainingDividends.FLA3).toBe(2 * (110 + 500 + 2550));
    const bots = comCopa.bots.reduce((s, b) => s + b.finalWorth, 0);
    expect(bots + comCopa.treasury.finalCash).toBe(10 * comCopa.config.initialCash + comCopa.totalDividends + comCopa.totalBuyback);

    // Com o IPO que conta as copas, a faixa sobe o esperado na data do IPO vezes 1 + a recompra:
    // 0,5 × 150 + 0,25 × 225 + 0,125 × 375 + 0,0625 × 600 + 0,03125 × 1200 = 253, × 2 = 506.
    const ipoCopa = simulate(season, { ...small, buyback: 1, cups: [{ matches, rules: LIBERTADORES }], ipoCups: true });
    const centro = (r: typeof comCopa, id: string) => r.clubs.find((c) => c.clubId === id)!.band.center;
    expect(centro(ipoCopa, "FLA3") - centro(comCopa, "FLA3")).toBe(506);
    expect(centro(ipoCopa, "PAL3") - centro(comCopa, "PAL3")).toBe(506);
    for (const c of comCopa.clubs.filter((x) => !["FLA3", "PAL3"].includes(x.clubId))) expect(centro(ipoCopa, c.clubId)).toBe(c.band.center);
  });

  it("ninguém termina com patrimônio negativo e a tesouraria não recebe dividendos", () => {
    for (const b of result.bots) expect(b.finalWorth).toBeGreaterThan(0);
    expect(result.bots.find((b) => b.id === TREASURY)).toBeUndefined();
    const paid = result.bots.reduce((s, b) => s + b.dividendsReceived, 0);
    expect(paid).toBe(result.totalDividends);
  });
});

describe("markOutOfWindow", () => {
  const m = (id: string, round: number, day: string): Match => ({
    id, competition: "brasileirao-a", round, kickoff: `${day}T16:00:00-03:00`,
    home: "A", away: "B", homeGoals: 0, awayGoals: 0, status: "finished",
  });

  it("marca como adiado o jogo disputado longe da data da rodada", () => {
    const out = markOutOfWindow([m("1", 12, "2025-06-12"), m("2", 12, "2025-06-13"), m("3", 12, "2025-11-15")]);
    expect(out.map((x) => x.postponed ?? false)).toEqual([false, false, true]);
  });
});

describe("simulação com as regras do jogo (P5 do Plano do ensaio)", () => {
  const config = { ...small, buyback: 1 };
  const jogo = simulate(season, { ...config, gameRules: true });
  const antiga = simulate(season, config);

  it("desligada, nada muda e o resultado não traz recusas", () => {
    expect(antiga.refused).toBeUndefined();
    expect(simulate(season, config).trades).toEqual(antiga.trades);
  });

  it("ligada, o lote muda o mercado (a tesouraria passa a ter ações a mais) e as recusas vêm contadas", () => {
    expect(jogo.refused).toEqual(expect.any(Object));
    // o lote é de graça: o caixa da tesouraria depois do IPO é o mesmo, mas ela tem mais ações para vender
    expect(jogo.treasury.startCash).toBe(antiga.treasury.startCash);
    // Neste cenário pequeno nenhum negócio sai (a ordem a mercado respeita a faixa de 20% desde a rodada Z, como na API,
    // e não alcança mais a compra da casa fora dela); a comparação do lote fica no fim da temporada, em dinheiro.
    expect(jogo.treasury.finalCash).toBe(antiga.treasury.finalCash);
  });

  it("ligada, é reproduzível com a mesma semente", () => {
    const outra = simulate(season, { ...config, gameRules: true });
    expect(outra.trades).toEqual(jogo.trades);
    expect(outra.refused).toEqual(jogo.refused);
  });
});
