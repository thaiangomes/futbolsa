import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { recusarBancoNaoLocal, recusarProducao } from "../../ensaio/guardas.js";
import { criarServidorEnsaio, abrirControle } from "../../ensaio/servidor.js";
import { createTestDatabase } from "../support/db.js";

function arquivos(dir: string): string[] {
  return readdirSync(dir).flatMap((nome) => {
    const caminho = join(dir, nome);
    return statSync(caminho).isDirectory() ? arquivos(caminho) : [caminho];
  });
}

describe("guardas do ensaio (P1)", () => {
  it("recusa banco do Supabase e de qualquer host fora da máquina", () => {
    expect(() => recusarBancoNaoLocal("postgres://u:s@db.abc.supabase.co:5432/postgres")).toThrow(/hospedado/);
    expect(() => recusarBancoNaoLocal("postgres://u:s@aws-0.pooler.supabase.com:6543/postgres")).toThrow(/hospedado/);
    expect(() => recusarBancoNaoLocal("postgres://u:s@banco.exemplo.com/x")).toThrow(/local/);
  });

  it("aceita localhost, 127.0.0.1 e serviço de contêiner", () => {
    expect(() => recusarBancoNaoLocal("postgres://u:s@localhost:5432/x")).not.toThrow();
    expect(() => recusarBancoNaoLocal("postgres://u:s@127.0.0.1:5433/x")).not.toThrow();
    expect(() => recusarBancoNaoLocal("postgres://u:s@postgres-test:5432/x")).not.toThrow();
  });

  it("não sobe com NODE_ENV=production", () => {
    expect(() => recusarProducao({ NODE_ENV: "production" })).toThrow(/production/);
    expect(() => recusarProducao({ NODE_ENV: "test" })).not.toThrow();
  });

  it("nada em src/ importa as pastas de ensaio, carga ou test", () => {
    for (const arquivo of arquivos("src").filter((a) => a.endsWith(".ts"))) {
      expect(readFileSync(arquivo, "utf8"), arquivo).not.toMatch(/from\s+["'][./]*(ensaio|carga|test)\//);
    }
  });

  it("a imagem Docker não leva ensaio nem carga (.dockerignore) e o build só olha src/", () => {
    const ignore = readFileSync("../../.dockerignore", "utf8");
    expect(ignore).toContain("apps/api/ensaio");
    expect(ignore).toContain("apps/api/carga");
    expect(readFileSync("tsconfig.build.json", "utf8")).toMatch(/"include": \["src"\]/);
  });
});

describe("servidor do ensaio e porta de controle", () => {
  it("sobe a API com relógio fixo, responde /health, avança o relógio e derruba e sobe de novo", async () => {
    const banco = await createTestDatabase(5);
    const servidor = await criarServidorEnsaio({ databaseUrl: banco.url, inicio: new Date("2025-03-01T12:00:00Z"), poolSize: 5 });
    const controle = await abrirControle(servidor, { eco: async (c) => c });
    try {
      expect((await fetch(`${servidor.url}/health`)).status).toBe(200);
      const hora = async () => ((await (await fetch(`${controle.url}/hora`)).json()) as { agora: string }).agora;
      expect(await hora()).toBe("2025-03-01T12:00:00.000Z");
      await fetch(`${controle.url}/avancar`, { method: "POST", body: JSON.stringify({ ms: 3_600_000 }) });
      expect(await hora()).toBe("2025-03-01T13:00:00.000Z");
      const eco = await fetch(`${controle.url}/cenario/eco`, { method: "POST", body: JSON.stringify({ a: 1 }) });
      expect(await eco.json()).toEqual({ a: 1 });
      await fetch(`${controle.url}/derrubar`, { method: "POST" });
      await servidor.subir();
      expect((await fetch(`${servidor.url}/health`)).status).toBe(200);
      expect(await hora()).toBe("2025-03-01T13:00:00.000Z");
    } finally {
      await controle.fechar();
      await servidor.fechar();
      await banco.close();
    }
  });

  it("recusa subir num banco do Supabase", async () => {
    await expect(criarServidorEnsaio({ databaseUrl: "postgres://u:s@db.x.supabase.co/postgres", inicio: new Date() })).rejects.toThrow(/hospedado/);
  });
});
