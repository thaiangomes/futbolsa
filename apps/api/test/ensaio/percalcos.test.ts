import { describe, expect, it } from "vitest";
import { executarEnsaio, type ContextoEnsaio } from "../../ensaio/ensaio.js";
import { criarPercalcos } from "../../ensaio/percalcos.js";
import { testDatabaseUrl } from "../support/db.js";

describe("ensaio com percalços (T11 e T12, parte automatizada)", () => {
  it("admin 23 a 27, livro 25 e 32, ipo 27: a API cai no IPO, suspensão de clube e do mercado, bloqueio, ajuste e desbloqueio, com o verificador todo dia", async () => {
    let ctx!: ContextoEnsaio;
    const percalcos = criarPercalcos(() => ctx);
    const { resultado, fechar } = await executarEnsaio({
      urlBase: testDatabaseUrl(),
      escala: 0.04,
      semente: 2,
      curta: { rodadas: 2 },
      jogadores: 4,
      ateDiasDepoisDaAbertura: 7,
      aoPreparar: (c) => void (ctx = c),
      ganchos: { antes: percalcos.antes },
    });
    try {
      expect(resultado.jogadores.erros5xx).toEqual([]);
      expect(percalcos.registros.map((r) => r.percalco)).toEqual([
        "API cai e volta no meio do IPO",
        "suspensão de um clube",
        "retomada do clube",
        "suspensão do mercado",
        "retomada do mercado",
        "bloqueio de um jogador",
        "ajuste de caixa pelo admin",
        "desbloqueio de um jogador",
      ]);
      expect(percalcos.registros.every((r) => r.ok)).toBe(true);
    } finally {
      await fechar();
    }
  }, 1_800_000);
});
