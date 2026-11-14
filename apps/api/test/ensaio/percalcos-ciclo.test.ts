import { describe, expect, it } from "vitest";
import { executarEnsaio, type ContextoEnsaio } from "../../ensaio/ensaio.js";
import { criarPercalcosDoCiclo } from "../../ensaio/percalcos-ciclo.js";
import { testDatabaseUrl } from "../support/db.js";

describe("ensaio com percalços do ciclo e do dinheiro (T11 e T12)", () => {
  it("admin 6 a 13, 29, 30, 35; conta 22, 23; entrada 1: adiado, cancelado, placar à mão, correção com estorno, exclusões, entrada no meio e bots", async () => {
    let ctx!: ContextoEnsaio;
    const percalcos = criarPercalcosDoCiclo(() => ctx);
    const { resultado, fechar } = await executarEnsaio({
      urlBase: testDatabaseUrl(),
      escala: 0.04,
      semente: 3,
      curta: { rodadas: 2 },
      jogadores: 5,
      ateDiasDepoisDaAbertura: 22,
      // a correção depois do pagamento muda o ranking de um mês fechado de propósito (Rankings 9, 10)
      conferirRankingsNoFim: false,
      aoPreparar: (c) => void (ctx = c),
      ganchos: { antes: percalcos.antes },
    });
    try {
      expect(resultado.jogadores.erros5xx).toEqual([]);
      expect(percalcos.registros.filter((r) => !r.ok)).toEqual([]);
      expect(percalcos.registros.length).toBeGreaterThanOrEqual(14);
    } finally {
      await fechar();
    }
  }, 3_600_000);
});
