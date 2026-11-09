import { describe, expect, it } from "vitest";
import { lastDueRefresh, needsRefresh } from "../../src/modules/market/index.js";

// T11 do Plano do livro de ofertas e formador: a agenda da reposição da casa, só a conta pura (o horário é de Brasília, UTC-3).

const at = (iso: string) => new Date(iso);
const OPENS = at("2027-04-05T13:00:00Z"); // 10h de Brasília

describe("lastDueRefresh", () => {
  it("antes da abertura da negociação nada é devido", () => {
    expect(lastDueRefresh({ now: at("2027-04-05T12:59:59Z"), opensAt: OPENS, kickoffs: [] })).toBeNull();
    expect(lastDueRefresh({ now: at("2027-04-05T13:00:00Z"), opensAt: null, kickoffs: [] })).toBeNull();
  });

  it("livro 21: na abertura, às 10h, a primeira cotação é devida", () => {
    expect(lastDueRefresh({ now: at("2027-04-05T13:00:00Z"), opensAt: OPENS, kickoffs: [] })).toEqual(OPENS);
  });

  it("livro 25: a reposição devida é a última de 3 em 3 horas de Brasília (0h, 3h, 6h... 21h)", () => {
    // 10h05 e 11h59: ainda vale a da abertura, às 10h (a das 9h é anterior à abertura)
    expect(lastDueRefresh({ now: at("2027-04-05T13:05:00Z"), opensAt: OPENS, kickoffs: [] })).toEqual(OPENS);
    expect(lastDueRefresh({ now: at("2027-04-05T14:59:59Z"), opensAt: OPENS, kickoffs: [] })).toEqual(OPENS);
    // às 12h00 em ponto passa a valer a das 12h
    expect(lastDueRefresh({ now: at("2027-04-05T15:00:00Z"), opensAt: OPENS, kickoffs: [] })).toEqual(at("2027-04-05T15:00:00Z"));
    // 0h de Brasília = 3h UTC
    expect(lastDueRefresh({ now: at("2027-04-07T03:00:01Z"), opensAt: OPENS, kickoffs: [] })).toEqual(at("2027-04-07T03:00:00Z"));
    expect(lastDueRefresh({ now: at("2027-04-07T02:59:59Z"), opensAt: OPENS, kickoffs: [] })).toEqual(at("2027-04-07T00:00:00Z"));
  });

  it("o início de um jogo do clube que já começou também é devido (o modo de jogo liga às 16h)", () => {
    const kickoff = at("2027-04-05T19:00:00Z"); // 16h de Brasília
    expect(lastDueRefresh({ now: at("2027-04-05T18:59:59Z"), opensAt: OPENS, kickoffs: [kickoff] })).toEqual(at("2027-04-05T18:00:00Z"));
    expect(lastDueRefresh({ now: at("2027-04-05T19:00:00Z"), opensAt: OPENS, kickoffs: [kickoff] })).toEqual(kickoff);
    // um jogo que começa às 16h30 vale até a próxima hora cheia de 3 em 3
    expect(lastDueRefresh({ now: at("2027-04-05T19:40:00Z"), opensAt: OPENS, kickoffs: [at("2027-04-05T19:30:00Z")] })).toEqual(at("2027-04-05T19:30:00Z"));
    // de 21h (Brasília) a 0h o horário de 3 em 3 horas das 21h supera o jogo das 16h
    expect(lastDueRefresh({ now: at("2027-04-06T00:30:00Z"), opensAt: OPENS, kickoffs: [kickoff] })).toEqual(at("2027-04-06T00:00:00Z"));
  });

  it("jogo que ainda não começou não conta", () => {
    expect(lastDueRefresh({ now: at("2027-04-05T14:00:00Z"), opensAt: OPENS, kickoffs: [at("2027-04-05T19:00:00Z")] })).toEqual(OPENS);
  });
});

describe("needsRefresh", () => {
  const due = at("2027-04-05T15:00:00Z"); // 12h

  it("livro 25: reposto às 10h05, só repõe de novo às 12h00", () => {
    const refreshed = at("2027-04-05T13:05:00Z");
    expect(needsRefresh({ refreshedAt: refreshed, due: OPENS, pendingRequest: false })).toBe(false);
    expect(needsRefresh({ refreshedAt: refreshed, due, pendingRequest: false })).toBe(true);
  });

  it("API fora das 9h às 13h: ao voltar repõe uma vez, não três, e depois não repõe de novo", () => {
    const refreshed = at("2027-04-05T12:00:00Z"); // 9h
    const backAt = at("2027-04-05T16:05:00Z"); // 13h05
    const dueNow = lastDueRefresh({ now: backAt, opensAt: OPENS, kickoffs: [] })!;
    expect(needsRefresh({ refreshedAt: refreshed, due: dueNow, pendingRequest: false })).toBe(true);
    // repôs às 13h05: os horários de 12h e antes não voltam
    expect(needsRefresh({ refreshedAt: backAt, due: dueNow, pendingRequest: false })).toBe(false);
  });

  it("reiniciar a API às 11h não repõe antes das 12h", () => {
    const refreshed = at("2027-04-05T13:00:00Z"); // abertura, 10h
    const dueAt11 = lastDueRefresh({ now: at("2027-04-05T14:00:00Z"), opensAt: OPENS, kickoffs: [] })!;
    expect(needsRefresh({ refreshedAt: refreshed, due: dueAt11, pendingRequest: false })).toBe(false);
  });

  it("clube nunca reposto precisa, e um pedido aberto repõe mesmo sem horário devido", () => {
    expect(needsRefresh({ refreshedAt: null, due: OPENS, pendingRequest: false })).toBe(true);
    expect(needsRefresh({ refreshedAt: at("2027-04-05T15:00:00Z"), due, pendingRequest: false })).toBe(false);
    expect(needsRefresh({ refreshedAt: at("2027-04-05T15:00:00Z"), due, pendingRequest: true })).toBe(true);
  });

  it("sem horário devido (a negociação não abriu), só o pedido repõe... e mesmo assim não antes da abertura", () => {
    expect(needsRefresh({ refreshedAt: null, due: null, pendingRequest: false })).toBe(false);
    expect(needsRefresh({ refreshedAt: null, due: null, pendingRequest: true })).toBe(false);
  });
});
