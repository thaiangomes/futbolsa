import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { medir, prepararCarga, type Preparado } from "../../carga/gerador.js";
import { subirServidorDeCarga, type ServidorCarga } from "../../carga/servidor.js";
import { useTestDatabase } from "../support/db.js";

/**
 * T16: o gerador de carga em ponto pequeno (10 jogadores, 5 conexões), contra o servidor da carga no mesmo processo: cria a
 * população, manda as ordens, recebe os eventos pelo WebSocket e termina com as invariantes passando. Não mede tempo nenhum.
 */
describe("T16: gerador de carga pequeno", () => {
  const t = useTestDatabase();
  let servidor: ServidorCarga;
  let preparado: Preparado;

  beforeAll(async () => {
    servidor = await subirServidorDeCarga({ databaseUrl: t.conn.url, poolSize: 10 });
    preparado = await prepararCarga({
      controleUrl: servidor.controleUrl,
      databaseUrl: t.conn.url,
      populacao: { clubes: 3, jogadores: 10, acoesPorClube: 50, acoesDaCasa: 5000 },
    });
    // a casa cota os três clubes antes das ordens
    await preparado.controle.cenario("reposicao");
  });

  afterAll(async () => {
    await preparado?.fechar();
    await servidor?.fechar();
  });

  it("cria 10 jogadores com carteira, manda ordens, entrega eventos e as invariantes passam", async () => {
    expect(preparado.jogadores).toHaveLength(10);
    const r = await medir(preparado, {
      nome: "pequena",
      descricao: "teste do gerador",
      degraus: [{ ordensPorSegundo: 5, segundos: 3 }],
      conexoes: 5,
      perfil: { leiturasPorOrdem: 1 },
    });
    const degrau = r.degraus[0]!;
    expect(degrau.status["2xx"]).toBeGreaterThan(5);
    expect(degrau.status["5xx"] ?? 0).toBe(0);
    expect(degrau.erros5xx).toEqual([]);
    expect(r.conexoes!.tentativas).toBe(5);
    expect(r.conexoes!.eventos).toBeGreaterThan(0);
    expect(r.conexoes!.buracosDeSeq).toBe(0);
    expect(r.servidor!.travas.club!.espera.n).toBeGreaterThan(0);
    expect(r.servidor!.travas.club!.retencao.n).toBeGreaterThan(0);
    expect(r.invariantes).toEqual({ ok: true, violacoes: [] });
  });
});
