import { describe, expect, it } from "vitest";
import { executarEnsaio } from "../../ensaio/ensaio.js";
import { testDatabaseUrl } from "../support/db.js";

describe("ensaio rápido (T10, parcial)", () => {
  it("ipo 23, carteira 19, dividendos 17 e 18: 9 perfis, temporada curta, da abertura do IPO a 6 dias de negociação, com o verificador todo dia (o fim da temporada fica para o ensaio completo)", async () => {
    const { resultado, fechar } = await executarEnsaio({ urlBase: testDatabaseUrl(), escala: 0.04, semente: 1, curta: { rodadas: 2 }, jogadores: 4, ateDiasDepoisDaAbertura: 6 });
    try {
      expect(resultado.jogadores.erros5xx).toEqual([]);
      expect(resultado.diasVerificados).toBeGreaterThan(10);
      expect(resultado.rankingsConferidos).toEqual([]); // o primeiro mês só fecha depois de 31 de março
      expect(resultado.jogadores.conferenciasDeLivro).toBeGreaterThan(0);
      expect(resultado.bots.resumo.ofertas).toBeGreaterThan(0);
    } finally {
      await fechar();
    }
  }, 1_800_000);
});
