import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regras de importação da arquitetura da Fase 1:
// - packages/engine não importa nada do projeto (@futbolsa/* nem apps/);
// - packages/contracts só importa o zod (e os próprios arquivos, por caminho relativo).
const raiz = fileURLToPath(new URL("../../..", import.meta.url));

function arquivos(dir: string): string[] {
  return readdirSync(dir).flatMap((nome) => {
    if (["node_modules", "dist", "sim-output"].includes(nome)) return [];
    const caminho = join(dir, nome);
    return statSync(caminho).isDirectory() ? arquivos(caminho) : /\.ts$/.test(nome) ? [caminho] : [];
  });
}

function importacoes(arquivo: string): string[] {
  const texto = readFileSync(arquivo, "utf8");
  const re = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  return [...texto.matchAll(re)].map((m) => (m[1] ?? m[2])!);
}

describe("regras de importação", () => {
  it("C6: packages/engine não importa @futbolsa/* nem apps/", () => {
    const violacoes = arquivos(join(raiz, "packages/engine")).flatMap((a) =>
      importacoes(a)
        .filter((i) => i.startsWith("@futbolsa/") || /(^|\/)apps\//.test(i) || /(^|\/)packages\/(?!engine)/.test(i))
        .map((i) => `${relative(raiz, a)} importa ${i}`),
    );
    expect(violacoes).toEqual([]);
  });

  it("C6: packages/contracts só importa o zod", () => {
    const violacoes = arquivos(join(raiz, "packages/contracts/src")).flatMap((a) =>
      importacoes(a)
        .filter((i) => !i.startsWith("./") && !i.startsWith("../") && i !== "zod")
        .map((i) => `${relative(raiz, a)} importa ${i}`),
    );
    expect(violacoes).toEqual([]);
  });

  it("C6: o detector enxerga importações proibidas", () => {
    expect(importacoes(join(raiz, "apps/api/src/health.controller.ts"))).toContain("@futbolsa/engine");
  });
});
