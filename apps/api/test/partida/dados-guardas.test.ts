import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { EspnEvent } from "@futbolsa/engine";
import { apagarBanco, criarTabelasDaPartida } from "../../partida/banco.js";
import { atualizarFotos, fotosMaisNovas, limiteDasFotos, semearFotos } from "../../partida/dados.js";
import { recusarAmbienteDaPartida, recusarBancoNaoLocalEstrito, ehEnderecoPrivado, recusarEscutaForaDoLocal } from "../../partida/guardas.js";
import { createTestDatabase, type TestDatabase } from "../support/db.js";

// F17: os dados no banco (D4) e as guardas da partida (critério 14).

function arquivos(dir: string): string[] {
  return readdirSync(dir).flatMap((nome) => {
    const caminho = join(dir, nome);
    return statSync(caminho).isDirectory() ? arquivos(caminho) : [caminho];
  });
}

describe("guardas da partida", () => {
  it("14: recusa NODE_ENV=production, banco que não é local e escuta fora de 127.0.0.1, com mensagem clara e sem senha", () => {
    expect(() => recusarAmbienteDaPartida({ urlBanco: "postgres://u:s@localhost:5432/x", env: { NODE_ENV: "production" } })).toThrow(/production/);
    expect(() => recusarAmbienteDaPartida({ urlBanco: "postgres://u:segredo@db.abc.supabase.co:5432/postgres" })).toThrow(/hospedado/);
    expect(() => recusarAmbienteDaPartida({ urlBanco: "postgres://u:segredo@banco.exemplo.com/x" })).toThrow(/local/);
    // diferente do ensaio, nem serviço de contêiner sem ponto no nome
    expect(() => recusarBancoNaoLocalEstrito("postgres://u:s@postgres-test:5432/x")).toThrow(/própria máquina/);
    expect(() => recusarBancoNaoLocalEstrito("postgres://u:s@localhost/x?host=db.abc.supabase.co")).toThrow();
    expect(() => recusarEscutaForaDoLocal("0.0.0.0")).toThrow(/127\.0\.0\.1/);
    expect(() => recusarEscutaForaDoLocal("192.168.0.10")).toThrow();
    expect(() => recusarAmbienteDaPartida({ urlBanco: "postgres://u:s@localhost:5432/x", host: "0.0.0.0" })).toThrow(/127\.0\.0\.1/);
    for (const url of ["postgres://u:segredo@db.abc.supabase.co:5432/postgres", "postgres://u:segredo@banco.exemplo.com/x"]) {
      try {
        recusarBancoNaoLocalEstrito(url);
      } catch (erro) {
        expect((erro as Error).message).not.toContain("segredo");
      }
    }
    expect(() => recusarAmbienteDaPartida({ urlBanco: "postgres://u:s@localhost:5432/x", host: "127.0.0.1", env: { NODE_ENV: "test" } })).not.toThrow();
  });

  it("14: a rede privada é opção explícita: só endereço privado, nunca 0.0.0.0 nem público, e a porta de controle continua local", () => {
    for (const ip of ["192.168.0.10", "192.168.255.1", "10.0.0.5", "10.255.1.1", "172.16.0.1", "172.31.255.254"]) {
      expect(ehEnderecoPrivado(ip), ip).toBe(true);
      expect(() => recusarEscutaForaDoLocal(ip, true), ip).not.toThrow();
      // sem a opção, o endereço de rede continua recusado
      expect(() => recusarEscutaForaDoLocal(ip), ip).toThrow(/127.0.0.1/);
    }
    for (const ip of ["0.0.0.0", "8.8.8.8", "172.15.0.1", "172.32.0.1", "192.169.0.1", "11.0.0.1", "192.168.0.256", "192.168.0", "exemplo.com", "::", "169.254.1.1", "100.64.0.1"]) {
      expect(ehEnderecoPrivado(ip), ip).toBe(false);
      expect(() => recusarEscutaForaDoLocal(ip, true), ip).toThrow(/rede privada/);
    }
    expect(() => recusarEscutaForaDoLocal("127.0.0.1", true)).not.toThrow();
    // o ambiente da partida (a porta de controle) segue exigindo o endereço local, mesmo com a opção de rede ligada no resto
    expect(() => recusarAmbienteDaPartida({ urlBanco: "postgres://u:s@localhost:5432/x", host: "192.168.0.10" })).toThrow(/127.0.0.1/);
  });

  it("14: a partida só mexe em bancos futbolsa_partida", async () => {
    await expect(apagarBanco("postgres://u:s@localhost:5432/x", "futbolsa_producao")).rejects.toThrow(/inválido/);
    await expect(apagarBanco("postgres://u:s@localhost:5432/x", "postgres")).rejects.toThrow(/inválido/);
  });

  it("13: nada em src/ importa a pasta da partida", () => {
    for (const arquivo of arquivos("src").filter((a) => a.endsWith(".ts"))) {
      expect(readFileSync(arquivo, "utf8"), arquivo).not.toMatch(/from\s+["'][./]*(partida)\//);
    }
    expect(readFileSync("../../.dockerignore", "utf8")).toContain("apps/api/partida");
  });

  it("22: nenhuma senha ou chave escrita nos arquivos da partida", () => {
    for (const arquivo of arquivos("partida").filter((a) => a.endsWith(".ts"))) {
      expect(readFileSync(arquivo, "utf8"), arquivo).not.toMatch(/postgres(ql)?:\/\/[^\s"'`$]+:[^\s"'`@$]+@/);
    }
  });
});

describe("dados da partida no banco (D4)", () => {
  let banco: TestDatabase;
  beforeAll(async () => {
    banco = await createTestDatabase(3);
    await criarTabelasDaPartida(banco.db);
  });
  afterAll(async () => banco.close());

  /** Os eventos da ESPN para os 5 campeonatos, no formato do placar: tudo igual ao do repositório, menos o que o teste muda. */
  function eventoDaEspn(id: string, data: string, casa: string, fora: string, estado: string, fase: string, gols = [2, 1]): EspnEvent {
    return {
      id,
      date: data,
      season: { slug: fase },
      competitions: [
        {
          status: { type: { name: estado } },
          competitors: [
            { homeAway: "home", score: String(gols[0]), winner: gols[0]! > gols[1]!, team: { displayName: casa } },
            { homeAway: "away", score: String(gols[1]), winner: gols[1]! > gols[0]!, team: { displayName: fora } },
          ],
        },
      ],
    };
  }

  const contar = async () => Number((await banco.db.execute<{ n: string }>(sql`select count(*)::text as n from public.partida_dados`)).rows[0]!.n);

  it("21: a primeira partida parte da foto do repositório (uma por competição, baixada em 2026-11-15)", async () => {
    expect(await semearFotos(banco.db)).toBe(true);
    expect(await semearFotos(banco.db)).toBe(false); // só semeia uma vez
    const inicial = await fotosMaisNovas(banco.db);
    expect(Object.keys(inicial).sort()).toEqual(["brasileirao-a", "brasileirao-b", "copa-do-brasil", "libertadores", "sul-americana"]);
    expect(new Date(limiteDasFotos(inicial)!).toISOString().slice(0, 10)).toBe("2026-11-15");
    expect(await contar()).toBe(5);
  });

  it("21: 'atualizar' com dados novos acrescenta a foto nova com a data da baixa, as antigas ficam e a mais nova vale", async () => {
    // a ESPN passa a devolver uma lista sem nenhum jogo terminado: é diferente de tudo o que está no banco
    const r = await atualizarFotos(banco.db, { hoje: new Date("2026-11-20T12:00:00Z"), baixar: async () => ({ events: [] }) });
    expect(r.mudaram.sort()).toEqual(["brasileirao-a", "brasileirao-b", "copa-do-brasil", "libertadores", "sul-americana"]);
    expect(await contar()).toBe(10); // as 5 antigas continuam lá
    expect(limiteDasFotos(await fotosMaisNovas(banco.db))).toBeNull(); // vale a mais nova
    const datas = (await banco.db.execute<{ d: string }>(sql`select distinct baixado_em::date::text as d from public.partida_dados order by 1`)).rows.map((l) => l.d);
    expect(datas).toEqual(["2026-11-15", "2026-11-20"]);
  });

  it("8: sem nada de novo nenhuma foto é gravada; falha de rede ou dado estranho não grava nada e o banco fica como estava", async () => {
    const antes = await contar();
    const igual = await atualizarFotos(banco.db, { hoje: new Date("2026-11-21T12:00:00Z"), baixar: async () => ({ events: [] }) });
    expect(igual.mudaram).toEqual([]);
    expect(await contar()).toBe(antes);
    await expect(
      atualizarFotos(banco.db, {
        hoje: new Date("2026-11-21T12:00:00Z"),
        baixar: async () => {
          throw new Error("a ESPN respondeu 503");
        },
      }),
    ).rejects.toThrow(/não consegui atualizar os dados da ESPN: a ESPN respondeu 503/);
    await expect(
      atualizarFotos(banco.db, { hoje: new Date(), baixar: async () => ({ events: [eventoDaEspn("1", "2026-05-01T20:00Z", "Copa Estranha", "Time Novo", "STATUS_FULL_TIME", "fase-nova")] }) }),
    ).rejects.toThrow(/não consegui atualizar os dados da ESPN/);
    expect(await contar()).toBe(antes);
  });
});
