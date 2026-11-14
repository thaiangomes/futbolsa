import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BOT_PROFILE_NAMES } from "@futbolsa/contracts";
import { AgenteDeBots, carteirasDeBots, contagemDeBots, ligarBots } from "../../ensaio/bots.js";
import { Condutor, HORA } from "../../ensaio/condutor.js";
import { carregarTemporada2025, type Carregado } from "../../ensaio/carregar.js";
import { criarServidorEnsaio, type ServidorEnsaio } from "../../ensaio/servidor.js";
import { ipoBids, seasons } from "../../src/infra/db/schema/index.js";
import { createTestDatabase, type TestDatabase } from "../support/db.js";
import { rng } from "../support/fixtures.js";

describe("bots do ensaio (T6)", () => {
  it("admin 29: a escala multiplica cada perfil e os 9 perfis estão sempre presentes (mínimo 1)", () => {
    expect(Object.values(contagemDeBots(1)).reduce((a, b) => a + b, 0)).toBe(250); // 8 perfis de 25 e 50 traders (o plano dizia 275: era a conta errada)
    expect(contagemDeBots(0.2)).toMatchObject({ dividendos: 5, trader: 10 });
    const minimo = contagemDeBots(0.001);
    expect(BOT_PROFILE_NAMES.every((p) => minimo[p] === 1)).toBe(true);
    expect(() => contagemDeBots(0)).toThrow(/escala/);
  });

  describe("com a temporada de 2025", () => {
    let banco: TestDatabase;
    let servidor: ServidorEnsaio;
    let carga: Carregado;
    beforeAll(async () => {
      banco = await createTestDatabase(12);
      servidor = await criarServidorEnsaio({ databaseUrl: banco.url, inicio: new Date("2025-03-01T12:00:00Z"), poolSize: 12 });
      carga = await carregarTemporada2025(servidor, { offerSize: 1000 });
      servidor.clock.set(new Date(carga.ipo.opensAt.getTime() - 24 * HORA));
    });
    afterAll(async () => {
      await servidor.fechar();
      await banco.close();
    });

    it("admin 30: os 9 perfis ofertam no IPO e negociam depois da abertura", async () => {
      const contagem = await ligarBots(servidor, carga, 0.04);
      expect(Object.keys(contagem)).toHaveLength(9);
      const agente = new AgenteDeBots(servidor, rng(3));
      const condutor = new Condutor(servidor, carga, { sorteio: rng(5), ganchos: { agir: async (p) => void (await agente.agir(p)) } });
      await condutor.rodarAte(new Date(carga.ipo.tradingOpensAt.getTime() + 3 * 24 * HORA));
      const [temporada] = await servidor.conexao.db.select().from(seasons).where(eq(seasons.id, carga.seasonId));
      expect(temporada!.status).toBe("trading");
      expect(await carteirasDeBots(servidor, carga.seasonId)).toBe(Object.values(contagem).reduce((a, b) => a + b, 0));
      expect(agente.resumo.ofertas).toBeGreaterThan(0);
      expect((await servidor.conexao.db.select().from(ipoBids)).length).toBeGreaterThan(0);
      expect(agente.resumo.rodadas).toBeGreaterThan(10);
    }, 600_000);
  });
});
