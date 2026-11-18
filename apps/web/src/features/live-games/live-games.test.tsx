// @vitest-environment jsdom
import type { LiveGame, LiveGames, LiveGameSide } from "@futbolsa/contracts";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { useDom } from "../../test-support/dom";
import { applyPriceToGames, changeTone, formatDayChange, liveCountText, phaseText, showStrip, siglaOf } from "./model";
import { LiveGamesContent } from "./screen";
import { LiveStripView } from "./strip";

// Item 25 da fila da partida de teste: a faixa dos jogos ao vivo e a página (Protótipos, "Jogos ao vivo").

const side = (ticker: string, name: string, price: number, changeBp: number): LiveGameSide => ({ ticker, name, price, changeBp });
const game = (over: Partial<LiveGame> = {}): LiveGame => ({
  competition: "brasileirao-a",
  round: 9,
  phase: null,
  kickoff: "2027-06-13T19:00:00.000Z",
  minute: 38,
  score: { home: 1, away: 1 },
  home: side("FLA3", "Flamengo", 4430, 302),
  away: side("BOT3", "Botafogo", 4680, -86),
  ...over,
});
const second = game({ home: side("PAL3", "Palmeiras", 4310, -46), away: side("SAO3", "São Paulo", 3390, 30), score: { home: 0, away: 1 }, minute: 39 });
const empty: LiveGames = { live: [], upcoming: [], finished: [], next: null };

describe("regras da faixa", () => {
  it("só aparece com jogo em andamento", () => {
    expect(showStrip(null)).toBe(false);
    expect(showStrip(empty)).toBe(false);
    expect(showStrip({ ...empty, upcoming: [game()], finished: [game()] })).toBe(false);
    expect(showStrip({ ...empty, live: [game()] })).toBe(true);
  });

  it("variação do dia: ▲ verde na alta, ▼ vermelha na queda, vírgula decimal", () => {
    expect(formatDayChange(302)).toBe("▲3,02%");
    expect(formatDayChange(-86)).toBe("▼0,86%");
    expect(formatDayChange(0)).toBe("0,00%");
    expect(formatDayChange(null)).toBe("");
    expect(changeTone(302)).toBe("up");
    expect(changeTone(-86)).toBe("down");
    expect(changeTone(0)).toBe("muted");
  });

  it("sigla de três letras, minuto e tempo de jogo, contagem no singular e no plural", () => {
    expect(siglaOf(side("FLA3", "Flamengo", 1, 1))).toBe("FLA");
    expect(phaseText(game({ minute: 38 }))).toBe("1º tempo · 38'");
    expect(phaseText(game({ minute: 53 }))).toBe("2º tempo · 53'");
    expect(phaseText(game({ minute: null }))).toBe("Em andamento");
    expect(liveCountText(1)).toBe("1 jogo ao vivo");
    expect(liveCountText(5)).toBe("5 jogos ao vivo");
  });

  it("um evento de preço troca preço e variação do clube em todos os jogos", () => {
    const next = applyPriceToGames({ ...empty, live: [game()], next: game() }, { ticker: "FLA3", price: 4500, changeBp: 450, auction: null });
    expect(next.live[0]!.home).toMatchObject({ price: 4500, changeBp: 450 });
    expect(next.live[0]!.away.changeBp).toBe(-86);
    expect(next.next!.home.changeBp).toBe(450);
  });
});

describe("faixa dos jogos ao vivo", () => {
  const dom = useDom();
  const mount = (games: LiveGame[]) => dom.render(createElement(LiveStripView, { games }));

  it("sem jogo em andamento não desenha nada", async () => {
    await mount([]);
    expect(dom.$('[data-testid="faixa-ao-vivo"]')).toBeNull();
  });

  it("mostra a variação do dia ao lado de cada sigla, o placar no meio e o minuto; tocar no time abre o Mercado do clube", async () => {
    await mount([game(), second]);
    const first = dom.$$('[data-testid="faixa-jogo"]')[0]!;
    expect(first.textContent).toBe("▲3,02%FLA1 × 1BOT▼0,86%38'");
    expect([...first.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["/clube?t=FLA3", "/clube?t=BOT3"]);
    expect(first.querySelector(".up")!.textContent).toBe("▲3,02%");
    expect(first.querySelector(".down")!.textContent).toBe("▼0,86%");
    expect(dom.$('a[href="/jogos-ao-vivo"]').textContent).toBe("Todos os jogos ›");
  });

  it("no celular passa de um jogo para o próximo (1/2 ›) e recolhe numa linha fina", async () => {
    await mount([game(), second]);
    expect(dom.$(".live-cel").textContent).toContain("FLA");
    await dom.click(dom.button("1/2 ›", dom.$(".live-cel")));
    expect(dom.$(".live-cel").textContent).toContain("PAL");
    await dom.click(dom.$('button[aria-label="Recolher a faixa dos jogos"]'));
    expect(dom.$(".live-cel").textContent).toContain("2 jogos ao vivo");
    await dom.click(dom.$('button[aria-label="Mostrar a faixa dos jogos ao vivo"]'));
    expect(dom.$('button[aria-label="Recolher a faixa dos jogos"]')).not.toBeNull();
  });
});

describe("página dos jogos ao vivo", () => {
  const dom = useDom();

  it("um cartão por jogo, com minuto, preço, variação do dia e placar de cada time, e o aviso do atraso", async () => {
    await dom.render(
      createElement(LiveGamesContent, {
        data: {
          ...empty,
          live: [game(), second],
          upcoming: [game({ kickoff: "2027-06-13T21:30:00.000Z", minute: null, score: null })],
          finished: [game({ score: { home: 2, away: 1 }, minute: null })],
        },
      }),
    );
    const cards = dom.$$('[data-testid="jogo-ao-vivo"]');
    expect(cards).toHaveLength(2);
    expect(cards[0]!.textContent).toContain("Brasileirão · Rodada 9");
    expect(cards[0]!.textContent).toContain("1º tempo · 38'");
    expect(cards[0]!.textContent).toContain("FLA3");
    expect(cards[0]!.textContent).toContain("▲3,02%");
    expect([...cards[0]!.querySelectorAll('[data-testid="time-gols"]')].map((e) => e.textContent)).toEqual(["1", "1"]);
    expect(dom.$('[data-testid="aviso-atraso"]').textContent).toBe("O placar pode estar até 5 minutos atrasado; gol não paga dividendo, só o resultado final.");
    expect(dom.$$('[data-testid="mais-tarde"]')).toHaveLength(1);
    expect(dom.$('[data-testid="encerrado"]').textContent).toContain("FLA 2 × 1 BOT");
  });

  it("sem jogo em andamento mostra o próximo jogo", async () => {
    await dom.render(
      createElement(LiveGamesContent, {
        data: { ...empty, next: game({ kickoff: "2027-06-16T22:00:00.000Z", competition: "copa-do-brasil", round: null, phase: "oitavas", minute: null, score: null }) },
      }),
    );
    expect(dom.$$('[data-testid="jogo-ao-vivo"]')).toHaveLength(0);
    expect(dom.$('[data-testid="proximo-jogo"]').textContent).toContain("Copa do Brasil · Oitavas · FLA × BOT");
  });
});
