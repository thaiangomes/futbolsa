import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgenteDeBots, ligarBots } from "../../ensaio/bots.js";
import { carregarTemporada2025, type Carregado } from "../../ensaio/carregar.js";
import { Condutor, HORA } from "../../ensaio/condutor.js";
import { Jogadores } from "../../ensaio/jogadores.js";
import { criarServidorEnsaio, type ServidorEnsaio } from "../../ensaio/servidor.js";
import { createTestDatabase, type TestDatabase } from "../support/db.js";
import { rng } from "../support/fixtures.js";

describe("jogadores de teste (T7)", () => {
  let banco: TestDatabase;
  let servidor: ServidorEnsaio;
  let carga: Carregado;
  beforeAll(async () => {
    banco = await createTestDatabase(15);
    servidor = await criarServidorEnsaio({ databaseUrl: banco.url, inicio: new Date("2025-03-01T12:00:00Z"), poolSize: 15 });
    carga = await carregarTemporada2025(servidor, { offerSize: 1000 });
    servidor.clock.set(new Date(carga.ipo.opensAt.getTime() - 24 * HORA));
  });
  afterAll(async () => {
    await servidor.fechar();
    await banco.close();
  });

  it("livro 18, 19, 35; carteira 33; conta 11: usam HTTP e WebSocket de verdade e o livro dos eventos é igual ao da REST", async () => {
    await ligarBots(servidor, carga, 0.04);
    const bots = new AgenteDeBots(servidor, rng(3));
    const jogadores = new Jogadores(servidor, carga, { quantos: 6, sorteio: rng(11) });
    const condutor = new Condutor(servidor, carga, {
      sorteio: rng(5),
      ganchos: {
        agir: async (p) => {
          await bots.agir(p);
          await jogadores.agir(p);
        },
      },
    });
    // abrir o IPO primeiro: o cadastro funciona a qualquer hora, mas a carteira nasce com o IPO aberto
    await condutor.rodarAte(new Date(carga.ipo.opensAt.getTime() + HORA));
    await jogadores.cadastrar(carga.tickers);
    await condutor.rodarAte(new Date(carga.ipo.tradingOpensAt.getTime() + 2 * 24 * HORA));
    await new Promise((r) => setTimeout(r, 1500));
    await jogadores.conferirLivrosDoOuvinte();
    jogadores.fechar();
    expect(jogadores.resumo.erros5xx).toEqual([]);
    expect(jogadores.resumo.ofertasNoIpo).toBeGreaterThan(0);
    expect(jogadores.resumo.ordens).toBeGreaterThan(0);
    expect(jogadores.resumo.conferenciasDeLivro).toBeGreaterThan(0);
  }, 900_000);
});
