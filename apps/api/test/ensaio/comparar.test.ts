import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { comparar, lerLimites, referenciaExata, relatorioMarkdown, type Medidas } from "../../ensaio/comparar.js";

const lote = JSON.parse(readFileSync("ensaio/referencia/lote-regras-do-jogo.json", "utf8")) as Array<Record<string, unknown>>;

describe("comparação com a simulação (T9)", () => {
  const exata = referenciaExata();
  const medias = (retorno = 0.4): Medidas => ({
    bandas: exata.bandas,
    dividendosPorAcao: exata.dividendosPorAcao,
    recompraPorAcao: exata.recompraPorAcao,
    precoFinalSobreIpo: 1.03,
    negociosPorBot: 56_000 / 250,
    bots: 50,
    retornoPorPerfil: { dividendos: retorno },
  });

  it("dividendos 1: a referência exata cobre os 20 clubes e tem dividendo e recompra por ação", () => {
    expect(Object.keys(exata.bandas)).toHaveLength(20);
    expect(Object.values(exata.dividendosPorAcao).every((d) => d > 0)).toBe(true);
  });

  it("um ensaio igual à referência passa em todas as medidas exatas e por faixa", () => {
    const linhas = comparar(medias(), exata, lote, lerLimites());
    expect(linhas.filter((l) => !l.ok)).toEqual([]);
  });

  it("dividendos 6: um dividendo diferente, um preço fora da faixa e um retorno fora da faixa são acusados", () => {
    const m = medias(5);
    m.dividendosPorAcao = { ...m.dividendosPorAcao, FLA3: (m.dividendosPorAcao.FLA3 ?? 0) + 1 };
    m.precoFinalSobreIpo = 2;
    const falhas = comparar(m, exata, lote, lerLimites()).filter((l) => !l.ok).map((l) => l.medida);
    expect(falhas).toEqual(expect.arrayContaining(["dividendos por ação FLA3", "preço final ÷ IPO", "retorno médio dividendos"]));
    expect(relatorioMarkdown(comparar(m, exata, lote, lerLimites()))).toContain("DIFERENTE");
  });
});
