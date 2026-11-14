import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Condutor, HORA, type Parada } from "../../ensaio/condutor.js";
import { carregarTemporada2025, type Carregado } from "../../ensaio/carregar.js";
import { criarServidorEnsaio, type ServidorEnsaio } from "../../ensaio/servidor.js";
import { seasons } from "../../src/infra/db/schema/index.js";
import { createTestDatabase, type TestDatabase } from "../support/db.js";
import { rng } from "../support/fixtures.js";

describe("condutor do relógio (T5)", () => {
  let banco: TestDatabase;
  let servidor: ServidorEnsaio;
  let carga: Carregado;
  const paradas: Parada[] = [];

  beforeAll(async () => {
    banco = await createTestDatabase(10);
    servidor = await criarServidorEnsaio({ databaseUrl: banco.url, inicio: new Date("2025-03-01T12:00:00Z"), poolSize: 10 });
    carga = await carregarTemporada2025(servidor, { offerSize: 3000 });
    servidor.clock.set(new Date(carga.ipo.opensAt.getTime() - 2 * 24 * HORA));
  });
  afterAll(async () => {
    await servidor.fechar();
    await banco.close();
  });

  it("admin 19, ipo 27: para nos instantes exatos do IPO e leva a temporada de preparação a negociação, sem pular parada de mais de 3 horas", async () => {
    const condutor = new Condutor(servidor, carga, { sorteio: rng(7), chanceDeRepetir: 0.2, ganchos: { depois: async (p) => void paradas.push(p) } });
    const status = async () => (await servidor.conexao.db.select().from(seasons).where(eq(seasons.id, carga.seasonId)))[0]!.status;
    await condutor.rodarAte(new Date(carga.ipo.tradingOpensAt.getTime() + 6 * HORA));
    expect(await status()).toBe("trading");
    const instantes = paradas.map((p) => p.em.getTime());
    expect(instantes).toContain(carga.ipo.opensAt.getTime());
    expect(instantes).toContain(carga.ipo.closesAt.getTime());
    expect(instantes).toContain(carga.ipo.tradingOpensAt.getTime());
    for (let i = 1; i < instantes.length; i++) expect(instantes[i]! - instantes[i - 1]!).toBeLessThanOrEqual(3 * HORA);
    expect(condutor.repeticoes).toBeGreaterThan(0);
  });
});
