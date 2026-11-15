import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Leitura dos nomes de teste do repositório inteiro (T24, P9 do Plano do ensaio, carga e testes no navegador): o motor, a API,
 * o site e o navegador. Um teste prova um critério quando o nome tem o prefixo da especificação e o número (`ipo 8`,
 * `livro 22, 20 e 18`, `rankings 19 a 21`), com `ensaio ` ou `e2e ` na frente nos testes de ponta a ponta.
 */
export const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** Prefixo de cada especificação no nome dos testes (a da F13 aceita `ranking` e `rankings`). */
export const PREFIXOS = {
  ipo: "ipo",
  livro: "livro",
  dividendos: "dividendos",
  carteira: "carteira",
  entrada: "entrada",
  rankings: "rankings?",
  admin: "admin",
  conta: "conta",
} as const;
export type Especificacao = keyof typeof PREFIXOS;

const PASTAS = ["packages/engine", "packages/contracts", "apps/api/test", "apps/web/src", "apps/web/e2e"];

function arquivos(pasta: string, acc: string[] = []): string[] {
  for (const nome of readdirSync(pasta)) {
    if (nome === "node_modules" || nome === "dist" || nome === ".next" || nome.startsWith("out")) continue;
    const caminho = join(pasta, nome);
    if (statSync(caminho).isDirectory()) arquivos(caminho, acc);
    else if (/\.(test|spec)\.tsx?$/.test(nome)) acc.push(caminho);
  }
  return acc;
}

export interface TesteLido {
  arquivo: string;
  nome: string;
}

/** Todo `it("...")` e `test("...")` dos arquivos de teste, com o nome como está escrito. */
export function lerTestes(): TesteLido[] {
  const nomes: TesteLido[] = [];
  const padrao = /\b(?:it|test)(?:\.[a-z]+)?\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g;
  for (const pasta of PASTAS) {
    for (const arquivo of arquivos(join(RAIZ, pasta))) {
      for (const m of readFileSync(arquivo, "utf8").matchAll(padrao)) nomes.push({ arquivo: arquivo.slice(RAIZ.length + 1).split("\\").join("/"), nome: m[2]! });
    }
  }
  return nomes;
}

/** Os números que um nome de teste prova para cada especificação (`ipo 8, 9, 10 e 11`, `rankings 19 a 21`). */
export function criteriosDoNome(nome: string): Array<{ spec: Especificacao; numero: number }> {
  const achados: Array<{ spec: Especificacao; numero: number }> = [];
  for (const [spec, prefixo] of Object.entries(PREFIXOS) as Array<[Especificacao, string]>) {
    const padrao = new RegExp(String.raw`(?<![\p{L}\d])${prefixo}\s+(\d+(?:\s*(?:,|/|e|a|ou)\s*\d+)*)`, "giu");
    for (const m of nome.matchAll(padrao)) {
      const pedacos = m[1]!.split(/\s*(,|\/|\be\b|\bou\b|\ba\b)\s*/).filter(Boolean);
      const lista = pedacos.filter((p) => /^\d+$/.test(p)).map(Number);
      const seps = pedacos.filter((p) => !/^\d+$/.test(p));
      lista.forEach((n, i) => {
        // "19 a 21" prova 19, 20 e 21
        if (i > 0 && seps[i - 1] === "a") for (let k = lista[i - 1]! + 1; k < n; k++) achados.push({ spec, numero: k });
        achados.push({ spec, numero: n });
      });
    }
  }
  return achados;
}

/** Os critérios provados, por especificação, e onde (os arquivos de cada número). */
export function cobertura(): Record<Especificacao, Map<number, Set<string>>> {
  const mapa = Object.fromEntries(Object.keys(PREFIXOS).map((s) => [s, new Map<number, Set<string>>()])) as Record<Especificacao, Map<number, Set<string>>>;
  for (const { arquivo, nome } of lerTestes()) {
    for (const { spec, numero } of criteriosDoNome(nome)) {
      const onde = mapa[spec].get(numero) ?? new Set<string>();
      onde.add(arquivo);
      mapa[spec].set(numero, onde);
    }
  }
  return mapa;
}
