import { describe, expect, it } from "vitest";
import { resolveSlots, type SlotRules } from "../src/engine/vagas.js";

// Critérios 2 a 5 de "Vagas e copas no valor justo dos bots".

const regras: SlotRules = {
  destinations: [
    {
      destination: "libertadores",
      tableSlots: 5,
      routes: [
        { cup: "copa-do-brasil", result: "champion" },
        { cup: "copa-do-brasil", result: "runnerUp" },
        { cup: "libertadores", result: "champion" },
        { cup: "sulamericana", result: "champion" },
      ],
    },
    { destination: "sulamericana", tableSlots: 4, routes: [] },
  ],
};

/** Classificação final: T1..T20, com os clubes do exemplo nas posições dele. */
function tabela(): string[] {
  const t = Array.from({ length: 20 }, (_, i) => `T${i + 1}`);
  t[1] = "PAL";
  t[5] = "CAM";
  t[8] = "VAS";
  t[16] = "GRE";
  return t;
}

describe("cascata das vagas", () => {
  it("o exemplo do Thaian: com os quatro fatos, o 9º colocado vai à Libertadores", () => {
    const vagas = resolveSlots(regras, tabela(), new Set(["GRE", "T18", "T19", "T20"]), {
      "copa-do-brasil": { champion: "PAL", runnerUp: "GRE" },
      libertadores: { champion: "PAL" },
      sulamericana: { champion: "CAM" },
    });
    expect(vagas.get("VAS")).toBe("libertadores");
    expect(vagas.get("PAL")).toBe("libertadores");
    expect(vagas.get("CAM")).toBe("libertadores");
    expect(vagas.has("GRE")).toBe(false);
    expect([...vagas.values()].filter((d) => d === "libertadores")).toHaveLength(9);
  });

  it("sem o Grêmio rebaixado, o 9º colocado não entra", () => {
    // o Grêmio é o 17º da tabela, mas não está entre os rebaixados deste cenário
    const t = tabela();
    const vagas = resolveSlots(regras, t, new Set(["T18", "T19", "T20", "T17"]), {
      "copa-do-brasil": { champion: "PAL", runnerUp: "GRE" },
      libertadores: { champion: "PAL" },
      sulamericana: { champion: "CAM" },
    });
    expect(vagas.get("GRE")).toBe("libertadores"); // vice da Copa do Brasil, não rebaixado
    expect(vagas.get("VAS")).not.toBe("libertadores");
  });

  it("rebaixado dono de rota não recebe vaga, e a vaga passa para a tabela", () => {
    const vagas = resolveSlots(regras, ["A", "B", "C", "D", "E", "F", "G", "H"], new Set(["B"]), {
      "copa-do-brasil": { champion: "B" },
    });
    expect(vagas.has("B")).toBe(false);
    // 5 da tabela + 1 devolvida, sem o rebaixado B: A, C, D, E, F, G
    expect([...vagas].filter(([, d]) => d === "libertadores").map(([c]) => c)).toEqual(["A", "C", "D", "E", "F", "G"]);
  });

  it("dono de duas rotas ocupa uma e a segunda passa para a tabela", () => {
    const vagas = resolveSlots(regras, ["A", "B", "C", "D", "E", "F", "G", "H"], new Set(), {
      "copa-do-brasil": { champion: "A" },
      libertadores: { champion: "A" },
    });
    // A (rota) + 5 da tabela + 1 devolvida = B..G na tabela
    expect([...vagas].filter(([, d]) => d === "libertadores").map(([c]) => c).sort()).toEqual(["A", "B", "C", "D", "E", "F", "G"]);
  });

  it("quem vai à Libertadores é pulado na Sul-Americana", () => {
    const vagas = resolveSlots(regras, ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N"], new Set(), {});
    expect(vagas.get("E")).toBe("libertadores");
    expect(vagas.get("F")).toBe("sulamericana");
    expect([...vagas.values()].filter((d) => d === "sulamericana")).toHaveLength(4);
    expect(vagas.has("J")).toBe(false);
  });

  it("campeão estrangeiro ou de fora da Série A não mexe na tabela", () => {
    const vagas = resolveSlots(regras, ["A", "B", "C", "D", "E", "F", "G"], new Set(), { libertadores: { champion: "BOCA" } });
    expect([...vagas.values()].filter((d) => d === "libertadores")).toHaveLength(5);
  });
});

