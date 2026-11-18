import { describe, expect, it } from "vitest";
import { classifyGames, LIVE_WINDOW_MS, type GameRow } from "../../src/modules/market/book/live-games.js";

// Item 25 da fila da partida de teste: a regra de quem está "em andamento" (a faixa só aparece com jogo em andamento).

const now = new Date("2027-06-13T19:40:00Z"); // 16h40 de Brasília
const dayStart = new Date("2027-06-13T03:00:00Z");
const nextDayStart = new Date("2027-06-14T03:00:00Z");
const prices = new Map([
  ["FLA3", { price: 4430, changeBp: 302 }],
  ["BOT3", { price: 4680, changeBp: 86 }],
]);
const opts = { now, dayStart, nextDayStart, prices, partials: [] as { home: string; away: string; homeGoals: number; awayGoals: number; minute: number }[] };
const game = (over: Partial<GameRow> = {}): GameRow => ({
  competition: "brasileirao-a",
  round: 9,
  phase: null,
  kickoff: new Date("2027-06-13T19:00:00Z"),
  status: "scheduled",
  homeGoals: null,
  awayGoals: null,
  home: { ticker: "FLA3", name: "Flamengo" },
  away: { ticker: "BOT3", name: "Botafogo" },
  ...over,
});

describe("jogos ao vivo: quem está em andamento", () => {
  it("jogo agendado que já começou é ao vivo; o placar parcial vem da fonte, com o preço e a variação do dia de cada time", () => {
    const view = classifyGames([game()], { ...opts, partials: [{ home: "FLA3", away: "BOT3", homeGoals: 1, awayGoals: 1, minute: 38 }] });
    expect(view.live).toHaveLength(1);
    expect(view.live[0]).toMatchObject({
      minute: 38,
      score: { home: 1, away: 1 },
      home: { ticker: "FLA3", price: 4430, changeBp: 302 },
      away: { ticker: "BOT3", price: 4680, changeBp: 86 },
    });
  });

  it("sem placar parcial o jogo segue ao vivo, com o minuto pelo horário de início e sem placar", () => {
    const [g] = classifyGames([game()], opts).live;
    expect(g!.score).toBeNull();
    expect(g!.minute).toBe(40);
  });

  it("sem jogo em andamento a lista fica vazia (e a faixa some): só mais tarde, encerrado, adiado, cancelado ou atrasado demais", () => {
    const view = classifyGames(
      [
        game({ kickoff: new Date("2027-06-13T21:30:00Z") }),
        game({ kickoff: new Date("2027-06-13T14:00:00Z"), status: "finished", homeGoals: 2, awayGoals: 1 }),
        game({ status: "postponed" }),
        game({ status: "cancelled" }),
        game({ kickoff: new Date(now.getTime() - LIVE_WINDOW_MS - 1) }), // começou há mais de 4 h e nada de resultado: atraso da fonte
      ],
      opts,
    );
    expect(view.live).toEqual([]);
    expect(view.upcoming).toHaveLength(1);
    expect(view.finished).toHaveLength(1);
  });

  it("encerrados de hoje com o placar final, o mais recente primeiro; os de ontem ficam de fora", () => {
    const view = classifyGames(
      [
        game({ kickoff: new Date("2027-06-13T13:00:00Z"), status: "finished", homeGoals: 2, awayGoals: 1 }),
        game({ kickoff: new Date("2027-06-13T16:00:00Z"), status: "finished", homeGoals: 0, awayGoals: 0 }),
        game({ kickoff: new Date("2027-06-12T22:00:00Z"), status: "finished", homeGoals: 3, awayGoals: 3 }),
      ],
      opts,
    );
    expect(view.finished.map((g) => g.score)).toEqual([{ home: 0, away: 0 }, { home: 2, away: 1 }]);
  });

  it("time que não é listado vem sem ticker, preço e variação", () => {
    const [g] = classifyGames([game({ away: { ticker: null, name: "Clube de Fora" } })], opts).live;
    expect(g!.away).toEqual({ ticker: null, name: "Clube de Fora", price: null, changeBp: null });
  });
});
