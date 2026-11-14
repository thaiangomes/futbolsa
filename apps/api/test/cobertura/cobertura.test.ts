import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cobertura, criteriosDoNome, type Especificacao, PREFIXOS } from "./cobertura.js";

/**
 * Auditoria de cobertura dos critérios (T24, P9 do Plano do ensaio, carga e testes no navegador): cada critério numerado das oito
 * especificações tem um teste com o número no nome (do motor, da API, do site ou do navegador) ou uma exceção com o motivo em
 * `criterios.json`. Um critério sem teste e sem exceção faz este teste falhar; uma exceção que já ganhou teste também falha (a
 * lista não envelhece).
 */
const criterios = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "criterios.json"), "utf8")) as {
  total: Record<Especificacao, number>;
  excecoes: Record<string, Record<string, string>>;
};

describe("cobertura dos critérios (T24)", () => {
  const mapa = cobertura();
  const especificacoes = Object.keys(PREFIXOS) as Especificacao[];

  it("o nome do teste diz quais critérios ele prova (prefixo da especificação e números)", () => {
    const f = (nome: string) => criteriosDoNome(nome).map((c) => `${c.spec} ${c.numero}`);
    expect(f("ipo 8, 9, 10 e 11: a reserva")).toEqual(["ipo 8", "ipo 9", "ipo 10", "ipo 11"]);
    expect(f("e2e livro 22, 20 e 18: negociação")).toEqual(["livro 22", "livro 20", "livro 18"]);
    expect(f("rankings 19 a 21: ranking anual")).toEqual(["rankings 19", "rankings 20", "rankings 21"]);
    expect(f("rankings 10 e Admin 16/36: junho")).toEqual(["rankings 10", "admin 16", "admin 36"]);
    expect(f("ranking 5: sem o s")).toEqual(["rankings 5"]);
    expect(f("um teste sem número de critério")).toEqual([]);
    expect(f("preço 12 de dezembro")).toEqual([]);
  });

  it.each(especificacoes)("%s: todo critério tem teste ou exceção com motivo", (spec) => {
    const total = criterios.total[spec];
    const excecoes = criterios.excecoes[spec] ?? {};
    const semTeste = Array.from({ length: total }, (_, i) => i + 1).filter((n) => !mapa[spec].has(n) && !excecoes[String(n)]);
    expect(semTeste, `${spec}: critérios sem teste e sem exceção`).toEqual([]);
    // nenhum teste aponta para um critério que a especificação não tem
    const alemDoTotal = [...mapa[spec].keys()].filter((n) => n > total);
    expect(alemDoTotal, `${spec}: testes com número acima do total (${total})`).toEqual([]);
  });

  it("a lista de exceções não tem critério que já ganhou teste, nem motivo vazio", () => {
    for (const [spec, lista] of Object.entries(criterios.excecoes)) {
      for (const [numero, motivo] of Object.entries(lista)) {
        expect(mapa[spec as Especificacao].has(Number(numero)), `${spec} ${numero} já tem teste: tire da lista de exceções`).toBe(false);
        expect(motivo.trim().length, `${spec} ${numero} sem motivo`).toBeGreaterThan(20);
      }
    }
  });

  it("o navegador prova pelo menos um critério de cada especificação (T20 e T21), menos dividendos", () => {
    // dividendos e recompra dependem de rodadas fechadas e de pagamentos aprovados: são do ensaio (T9 a T13); o navegador só
    // abre as telas de pagamentos e de correção do admin (jornada 7), sem provar um critério.
    for (const spec of especificacoes.filter((s) => s !== "dividendos")) {
      const noNavegador = [...mapa[spec].values()].some((arquivos) => [...arquivos].some((a) => a.startsWith("apps/web/e2e/")));
      expect(noNavegador, `${spec}: nenhum teste do navegador`).toBe(true);
    }
  });
});
