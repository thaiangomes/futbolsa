import type { LiveRanking, RankingRow } from "@futbolsa/contracts";
import { describe, expect, it } from "vitest";
import { applyLiveEvent, monthFromSearch, monthLabel, positionLabel, returnLabel, rowName, searchForMonth } from "./ranking-state";

// T9: a lógica de dados da tela de rankings (Rankings mensal e anual 6, 7, 15, 18, 21 e 22).

const row = (over: Partial<RankingRow> = {}): RankingRow => ({ position: 1, walletKey: "k", displayName: "Ana", isBot: false, botLabel: null, returnBp: 800, ...over });
const live = (over: Partial<LiveRanking> = {}): LiveRanking => ({ period: "month", periodKey: "2027-06", computedAt: "2027-06-10T12:00:10.000Z", seq: 1, botsIncluded: false, total: 2, offset: 0, rows: [row(), row({ position: 2, walletKey: "k2", displayName: "Bia", returnBp: 500 })], me: null, ...over });

describe("ranking-state", () => {
  it("empate mostra '2º' nas duas linhas e '4º' na seguinte", () => {
    expect([1, 2, 2, 4].map(positionLabel)).toEqual(["1º", "2º", "2º", "4º"]);
  });
  it("retorno com duas casas, sinal e '—' para quem está sem base", () => {
    expect(returnLabel(800)).toBe("+8,00%");
    expect(returnLabel(-10_025)).toBe("−100,25%");
    expect(returnLabel(0)).toBe("0,00%");
    expect(returnLabel(5)).toBe("+0,05%");
    expect(returnLabel(null)).toBe("—");
  });
  it("conta excluída mostra 'conta excluída' e bot mostra o rótulo", () => {
    expect(rowName(row({ displayName: null }))).toBe("conta excluída");
    expect(rowName(row({ displayName: null, isBot: true, botLabel: "Bot dividendos" }))).toBe("Bot dividendos");
    expect(rowName(row())).toBe("Ana");
  });
  it("o mês escolhido volta da query ao recarregar", () => {
    expect(monthFromSearch(searchForMonth("2027-06"))).toBe("2027-06");
    expect(monthFromSearch("?mes=2027-13")).toBeNull();
    expect(monthFromSearch("")).toBeNull();
    expect(monthLabel("2027-06")).toBe("junho de 2027");
  });
  it("o evento rankings.live com computedAt mais antigo que o da carga é descartado; o mais novo troca o topo e o total", () => {
    const state = live();
    const old = { period: "month" as const, periodKey: "2027-06", computedAt: "2027-06-10T12:00:00.000Z", total: 9, top: [row({ displayName: "Zé" })] };
    expect(applyLiveEvent(state, old)).toBe(state);
    const fresh = { ...old, computedAt: "2027-06-10T12:00:20.000Z", total: 3, top: [row({ displayName: "Zé" }), row({ position: 2, displayName: "Ana", walletKey: "k3" })] };
    const next = applyLiveEvent(state, fresh);
    expect(next.total).toBe(3);
    expect(next.rows[0]!.displayName).toBe("Zé");
    expect(next.computedAt).toBe(fresh.computedAt);
    expect(applyLiveEvent(state, { ...fresh, period: "season" })).toBe(state);
  });
});
