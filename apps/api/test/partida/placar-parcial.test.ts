import { describe, expect, it } from "vitest";
import type { Match } from "@futbolsa/engine";
import { AgenteDaPartida, ATIVIDADE_DOS_SALTOS, ATIVIDADE_NO_GOL, ATIVIDADE_NO_TEMPO_REAL, FocoDosBots } from "../../partida/bots.js";
import { ReplaySource } from "../../ensaio/replay-source.js";
import type { ServidorEnsaio } from "../../ensaio/servidor.js";

// Item 23 das melhorias: os bots negociam mais no tempo real e enxergam o placar parcial dos jogos em andamento.

const MIN = 60_000;
const jogo = (id: string, kickoff: string, extra: Partial<Match> = {}): Match => ({
  id,
  competition: "brasileirao-a",
  round: 30,
  kickoff,
  home: "FLA3",
  away: "PAL3",
  homeGoals: null,
  awayGoals: null,
  status: "scheduled",
  ...extra,
});

describe("placar parcial na fonte da partida (item 23)", () => {
  it("só aparece com o jogo em andamento: entre o apito e 3 horas depois, com o minuto de jogo", () => {
    let agora = new Date("2026-11-18T22:00:00Z");
    const fonte = new ReplaySource(() => agora, undefined, {
      ano: 2026,
      dados: {
        "brasileirao-a": [
          jogo("em-andamento", "2026-11-18T19:30:00-03:00", { parcial: { homeGoals: 1, awayGoals: 0 } }),
          jogo("sem-placar", "2026-11-18T19:30:00-03:00", { home: "SAN3", away: "BAH3" }),
          jogo("terminado", "2026-11-18T19:30:00-03:00", { home: "GRE3", away: "INT3", status: "finished", homeGoals: 2, awayGoals: 2, parcial: { homeGoals: 1, awayGoals: 1 } }),
        ],
        "copa-do-brasil": [jogo("copa", "2026-11-18T19:30:00-03:00", { competition: "copa-do-brasil", parcial: { homeGoals: 3, awayGoals: 0 } })],
      },
    });
    // 19h30 em Brasília = 22h30Z: antes do apito, nada
    expect(fonte.parciais()).toEqual([]);
    agora = new Date(new Date("2026-11-18T22:30:00Z").getTime() + 30 * MIN);
    expect(fonte.parciais()).toEqual([{ home: "FLA3", away: "PAL3", homeGoals: 1, awayGoals: 0, minute: 30 }]); // só o Brasileirão, só o em andamento
    agora = new Date(new Date("2026-11-18T22:30:00Z").getTime() + 4 * 60 * MIN);
    expect(fonte.parciais()).toEqual([]); // passou de 3 horas: o dado não vale mais
  });
});

describe("ritmo dos bots da partida (item 23)", () => {
  it("o tempo real (paradas de 5 minutos) usa o ritmo alto, e os saltos, o de antes", async () => {
    const config = { tickMinutes: 15, activityPer3h: ATIVIDADE_DOS_SALTOS };
    const relatorio = { skipped: false, placed: 0, cancelled: 0, bids: 0, wallets: 0, refused: {} };
    const servidor = { app: { get: () => ({ runOnce: async () => relatorio }) } } as unknown as ServidorEnsaio;
    const agente = new AgenteDaPartida(servidor, config);
    const parada = (iso: string) => ({ em: new Date(iso), motivo: "grade", novoDia: false });

    await agente.agir(parada("2026-11-18T22:00:00Z"));
    await agente.agir(parada("2026-11-18T22:05:00Z"));
    expect(config).toEqual({ tickMinutes: 5, activityPer3h: ATIVIDADE_NO_TEMPO_REAL });
    expect(ATIVIDADE_NO_TEMPO_REAL).toBeGreaterThan(ATIVIDADE_DOS_SALTOS);

    await agente.agir(parada("2026-11-19T01:05:00Z")); // um salto de 3 horas
    expect(config).toEqual({ tickMinutes: 180, activityPer3h: ATIVIDADE_DOS_SALTOS });
  });

  it("a parada em que aparece um gol novo tem a rodada extra; sem gol novo volta ao ritmo normal", async () => {
    const config = { tickMinutes: 15, activityPer3h: ATIVIDADE_DOS_SALTOS };
    const relatorio = { skipped: false, placed: 0, cancelled: 0, bids: 0, wallets: 0, refused: {} };
    const servidor = { app: { get: () => ({ runOnce: async () => relatorio }) } } as unknown as ServidorEnsaio;
    let placar = [{ home: "REM3", away: "CHA3", homeGoals: 1, awayGoals: 0 }];
    const agente = new AgenteDaPartida(servidor, config, () => placar);
    const parada = (iso: string) => ({ em: new Date(iso), motivo: "grade", novoDia: false });

    await agente.agir(parada("2026-11-18T23:00:00Z")); // primeira leitura: jogo já com 1 gol (partida reiniciada), não conta
    await agente.agir(parada("2026-11-18T23:05:00Z"));
    expect(config.activityPer3h).toBe(ATIVIDADE_NO_TEMPO_REAL);

    placar = [{ home: "REM3", away: "CHA3", homeGoals: 2, awayGoals: 0 }];
    await agente.agir(parada("2026-11-18T23:10:00Z"));
    expect(config.activityPer3h).toBe(ATIVIDADE_NO_GOL);
    expect(ATIVIDADE_NO_GOL).toBeGreaterThan(ATIVIDADE_NO_TEMPO_REAL);

    await agente.agir(parada("2026-11-18T23:15:00Z")); // o mesmo placar: acabou a rajada
    expect(config.activityPer3h).toBe(ATIVIDADE_NO_TEMPO_REAL);

    placar = []; // o jogo acabou: gols que somem não são gol novo
    await agente.agir(parada("2026-11-18T23:20:00Z"));
    expect(config.activityPer3h).toBe(ATIVIDADE_NO_TEMPO_REAL);

    placar = [{ home: "FLA3", away: "CAP3", homeGoals: 0, awayGoals: 1 }]; // jogo novo já com gol entre duas leituras
    await agente.agir(parada("2026-11-18T23:25:00Z"));
    expect(config.activityPer3h).toBe(ATIVIDADE_NO_GOL);
  });

  it("os clubes do jogo do gol ficam em foco só na rodada do gol e depois são limpos", async () => {
    const config = { tickMinutes: 15, activityPer3h: ATIVIDADE_DOS_SALTOS };
    const relatorio = { skipped: false, placed: 0, cancelled: 0, bids: 0, wallets: 0, refused: {} };
    const foco = new FocoDosBots();
    let vistoNaRodada: string[] = [];
    const servidor = { app: { get: () => ({ runOnce: async () => ((vistoNaRodada = [...foco.clubs()]), relatorio) }) } } as unknown as ServidorEnsaio;
    let placar = [
      { home: "COR3", away: "BOT3", homeGoals: 0, awayGoals: 0 },
      { home: "GRE3", away: "BAH3", homeGoals: 0, awayGoals: 0 },
    ];
    const agente = new AgenteDaPartida(servidor, config, () => placar, foco);
    const parada = (iso: string) => ({ em: new Date(iso), motivo: "grade", novoDia: false });

    await agente.agir(parada("2026-11-19T01:00:00Z"));
    await agente.agir(parada("2026-11-19T01:05:00Z"));
    expect(vistoNaRodada).toEqual([]); // sem gol, ninguém em foco

    placar = [{ ...placar[0]!, homeGoals: 1 }, placar[1]!];
    await agente.agir(parada("2026-11-19T01:10:00Z"));
    expect(vistoNaRodada).toEqual(["COR3", "BOT3"]); // só o jogo do gol
    expect(foco.clubs()).toEqual([]); // limpo depois da rodada

    await agente.agir(parada("2026-11-19T01:15:00Z"));
    expect(vistoNaRodada).toEqual([]);
  });
});
