import { describe, expect, it } from "vitest";
import { type CupMatch, cupOutcomeOf, cupPhaseOf } from "../../src/modules/dividends/club-value/cup-status.js";

const CDB = ["1a-fase", "2a-fase", "3a-fase", "oitavas", "quartas", "semifinal", "final"];
const LIB = ["grupos", "oitavas", "quartas", "semifinal", "final"];
const FLA = 1;
const PAL = 2;
const OUT = 3;

let kick = 0;
const jogo = (phase: string, home: number, away: number, status: string, advancedClubId: number | null = null): CupMatch => ({
  phase,
  status,
  homeClubId: home,
  awayClubId: away,
  advancedClubId,
  kickoff: new Date(Date.UTC(2027, 0, 1) + ++kick * 86_400_000),
});

describe("cupPhaseOf: onde o clube está numa copa (T12)", () => {
  it("clube sem jogo na copa não a disputa", () => {
    expect(cupPhaseOf([jogo("oitavas", PAL, OUT, "scheduled")], FLA, CDB)).toBeUndefined();
    expect(cupPhaseOf([], FLA, CDB)).toBeUndefined();
  });

  it("com jogo por disputar na fase, está nela", () => {
    expect(cupPhaseOf([jogo("oitavas", FLA, PAL, "scheduled")], FLA, CDB)).toBe("oitavas");
  });

  it("com a fase anterior já ganha e a seguinte por jogar, está na seguinte", () => {
    const jogos = [jogo("3a-fase", FLA, OUT, "finished", FLA), jogo("oitavas", FLA, PAL, "scheduled")];
    expect(cupPhaseOf(jogos, FLA, CDB)).toBe("oitavas");
  });

  it("a fonte já lista jogos de fases futuras: vale a fase mais antiga com jogo por disputar", () => {
    const jogos = [jogo("grupos", FLA, PAL, "scheduled"), jogo("oitavas", FLA, OUT, "scheduled"), jogo("quartas", FLA, OUT, "scheduled")];
    expect(cupPhaseOf(jogos, FLA, LIB)).toBe("grupos");
  });

  it("acabou o mata-mata e ele passou: está na fase seguinte, mesmo sem jogo marcado", () => {
    expect(cupPhaseOf([jogo("oitavas", FLA, PAL, "finished", FLA)], FLA, CDB)).toBe("quartas");
  });

  it("acabou o mata-mata e outro passou: já caiu", () => {
    expect(cupPhaseOf([jogo("oitavas", FLA, PAL, "finished", PAL)], FLA, CDB)).toBeNull();
  });

  it("ida e volta: vale quem passou indicado no último jogo da fase", () => {
    const jogos = [jogo("quartas", FLA, PAL, "finished"), jogo("quartas", PAL, FLA, "finished", FLA)];
    expect(cupPhaseOf(jogos, FLA, CDB)).toBe("semifinal");
  });

  it("ida e volta com a volta por jogar: segue na fase", () => {
    expect(cupPhaseOf([jogo("quartas", FLA, PAL, "finished"), jogo("quartas", PAL, FLA, "scheduled")], FLA, CDB)).toBe("quartas");
  });

  it("a final acabou: não há mais nada a receber da copa (campeão ou vice)", () => {
    expect(cupPhaseOf([jogo("final", FLA, PAL, "finished", FLA)], FLA, CDB)).toBeNull();
  });

  it("fase de grupos acabada e a fonte não diz quem passou: sem a fase seguinte iniciada, segue como está", () => {
    expect(cupPhaseOf([jogo("grupos", FLA, PAL, "finished"), jogo("grupos", OUT, FLA, "finished")], FLA, LIB)).toBe("grupos");
  });

  it("fase de grupos acabada e a fase seguinte começou sem ele: caiu", () => {
    const jogos = [jogo("grupos", FLA, PAL, "finished"), jogo("oitavas", PAL, OUT, "scheduled")];
    expect(cupPhaseOf(jogos, FLA, LIB)).toBeNull();
  });

  it("fase de grupos acabada e ele já está na fase seguinte: está nela", () => {
    const jogos = [jogo("grupos", FLA, PAL, "finished"), jogo("oitavas", FLA, OUT, "scheduled")];
    expect(cupPhaseOf(jogos, FLA, LIB)).toBe("oitavas");
  });

  describe("cupOutcomeOf: disputando, eliminado ou campeão (item 10 da fila da partida de teste)", () => {
    it("com jogo por disputar, está disputando; sem jogo na copa, não a disputa", () => {
      expect(cupOutcomeOf([jogo("oitavas", FLA, PAL, "scheduled")], FLA, CDB)).toBe("playing");
      expect(cupOutcomeOf([jogo("oitavas", PAL, OUT, "scheduled")], FLA, CDB)).toBeUndefined();
    });
    it("perdeu o mata-mata: eliminado; passou de fase: disputando", () => {
      expect(cupOutcomeOf([jogo("oitavas", FLA, PAL, "finished", PAL)], FLA, CDB)).toBe("eliminated");
      expect(cupOutcomeOf([jogo("oitavas", FLA, PAL, "finished", FLA)], FLA, CDB)).toBe("playing");
    });
    it("ganhou a final: campeão; perdeu a final: eliminado (vice)", () => {
      expect(cupOutcomeOf([jogo("final", FLA, PAL, "finished", FLA)], FLA, CDB)).toBe("champion");
      expect(cupOutcomeOf([jogo("final", FLA, PAL, "finished", PAL)], FLA, CDB)).toBe("eliminated");
    });
    it("final sem o campo de quem passou: vale o placar", () => {
      const final = { ...jogo("final", FLA, PAL, "finished"), homeGoals: 2, awayGoals: 1 };
      expect(cupOutcomeOf([final], FLA, CDB)).toBe("champion");
      expect(cupOutcomeOf([final], PAL, CDB)).toBe("eliminated");
    });
  });

  it("jogo cancelado não conta, nem fase que a tabela da copa não conhece", () => {
    expect(cupPhaseOf([jogo("oitavas", FLA, PAL, "cancelled")], FLA, CDB)).toBeUndefined();
    expect(cupPhaseOf([jogo("preliminar", FLA, PAL, "scheduled")], FLA, CDB)).toBeUndefined();
  });
});
