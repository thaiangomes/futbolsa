import { describe, expect, it } from "vitest";
import { rank } from "../src/engine/ranking.js";
import { reais } from "../src/engine/money.js";

const base = reais(100_000);
/** Linha com o retorno dado em pontos-base sobre R$ 100.000,00. */
const row = (id: string, bp: number) => ({ id, base, equity: base + (base * bp) / 10_000 });
const positions = (rows: { id: string; position: number }[]) => rows.map((r) => `${r.position}:${r.id}`);

describe("rank: ranking com empate", () => {
  it("rankings 6: +8%, +5%, +5% e +3% dão 1º, 2º, 2º e 4º", () => {
    const r = rank([row("bruno", 300), row("bot-dividendos", 500), row("ana", 800), row("carla", 500)]);
    expect(r[0]).toMatchObject({ id: "ana", position: 1 });
    expect(r[3]).toMatchObject({ id: "bruno", position: 4 });
    expect([r[1]!.position, r[2]!.position]).toEqual([2, 2]);
    expect(new Set([r[1]!.id, r[2]!.id])).toEqual(new Set(["carla", "bot-dividendos"]));
  });

  it("rankings 7: sem o bot (lista filtrada por quem chama) é 1º, 2º e 3º", () => {
    const r = rank([row("bruno", 300), row("ana", 800), row("carla", 500)]);
    expect(positions(r)).toEqual(["1:ana", "2:carla", "3:bruno"]);
  });

  it("rankings 15: retornos exatamente iguais dividem a posição e o seguinte pula", () => {
    const r = rank([row("a", 1_000), row("b", 700), row("c", 700), row("d", 700), row("e", 100)]);
    expect(r.map((x) => x.position)).toEqual([1, 2, 2, 2, 5]);
  });

  it("rankings 15: frações diferentes com o mesmo valor também empatam", () => {
    const r = rank([
      { id: "x", base: reais(1_000), equity: reais(1_050) },
      { id: "y", base: reais(20_000), equity: reais(21_000) },
      { id: "z", base: reais(100_000), equity: reais(110_000) },
    ]);
    // z rende +10%; x e y rendem exatamente +5% com bases diferentes.
    expect(positions(r)).toEqual(["1:z", "2:x", "2:y"]);
  });

  it("rankings 16: quem nunca negociou aparece com 0,00%", () => {
    const r = rank([row("novato", 0), row("ana", 250)]);
    expect(positions(r)).toEqual(["1:ana", "2:novato"]);
    expect(r[1]!.returnBp).toBe(0);
  });

  it("rankings 13: retorno abaixo de −100% fica por último", () => {
    const r = rank([
      { id: "bruno", base, equity: reais(-250) },
      row("ana", -9_900),
      row("carla", 0),
    ]);
    expect(positions(r)).toEqual(["1:carla", "2:ana", "3:bruno"]);
    expect(r[2]!.returnBp).toBeLessThan(-10_000);
  });

  it("rankings 4 e 5: cada linha leva a sua própria base (quem entrou no meio compara desde a entrada)", () => {
    const r = rank([
      { id: "ana", base: reais(112_000), equity: reais(120_960) }, // +8%
      { id: "bruno", base: reais(100_000), equity: reais(103_000) }, // +3%
    ]);
    expect(r.map((x) => [x.id, x.returnBp])).toEqual([
      ["ana", 800],
      ["bruno", 300],
    ]);
  });

  describe("limites", () => {
    it("lista vazia", () => {
      expect(rank([])).toEqual([]);
    });

    it("um só jogador é 1º", () => {
      expect(rank([row("ana", 10)])).toMatchObject([{ id: "ana", position: 1 }]);
    });

    it("todos empatados ficam em 1º", () => {
      expect(rank([row("a", 5), row("b", 5), row("c", 5)]).map((x) => x.position)).toEqual([1, 1, 1]);
    });

    it("regressão: o resultado não depende da ordem de entrada das linhas", () => {
      const linhas = [row("a", 900), row("b", 100), row("c", 900), row("d", -50), row("e", 100)];
      const ref = rank(linhas).map((x) => `${x.position}:${x.returnBp}`);
      for (const embaralhada of [[...linhas].reverse(), [linhas[3]!, linhas[0]!, linhas[4]!, linhas[2]!, linhas[1]!]]) {
        expect(rank(embaralhada).map((x) => `${x.position}:${x.returnBp}`)).toEqual(ref);
      }
    });

    it("empate mantém a ordem de entrada (ordenação estável)", () => {
      expect(rank([row("b", 5), row("a", 5)]).map((x) => x.id)).toEqual(["b", "a"]);
    });

    it("recusa base não positiva", () => {
      expect(() => rank([{ id: "a", base: 0, equity: 0 }])).toThrow();
    });
  });
});
