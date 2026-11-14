import { describe, expect, it } from "vitest";
import { executarEnsaio } from "../../ensaio/ensaio.js";
import { testDatabaseUrl } from "../support/db.js";

describe("ensaio rápido (T10)", () => {
  it("ipo 23, carteira 19, dividendos 17, 18, 21, 22, 24; rankings 19 a 21; conta 15; admin 21, 22: 9 perfis, da abertura do IPO ao encerramento, com o verificador todo dia", async () => {
    const { resultado, fechar } = await executarEnsaio({ urlBase: testDatabaseUrl(), escala: 0.04, semente: 1, curta: { rodadas: 2 }, jogadores: 4 });
    try {
      expect(resultado.jogadores.erros5xx).toEqual([]);
      expect(resultado.statusFinal).toBe("closed");
      expect(resultado.diasVerificados).toBeGreaterThan(20);
      expect(Object.keys(resultado.bots.contagem)).toHaveLength(9);
      expect(resultado.bots.resumo.ofertas).toBeGreaterThan(0);
      expect(resultado.jogadores.conferenciasDeLivro).toBeGreaterThan(0);
      // o ranking de cada mês fechado e o do ano batem com o recalculado pelo histórico
      expect(resultado.rankingsConferidos).toEqual(expect.arrayContaining(["month:2025-03", "season:2025"]));
      // ranking anual, histórico da conta e a temporada seguinte em preparação
      expect(resultado.fimDaTemporada).toHaveLength(3);
      expect(resultado.fimDaTemporada.filter((p) => p.status >= 300)).toEqual([]);
    } finally {
      await fechar();
    }
  }, 1_800_000);
});
