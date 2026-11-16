// @vitest-environment jsdom
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { useDom } from "../../../test-support/dom";
import type { AdminApi } from "../api";
import { RelogioScreen } from "./relogio-screen";
import type { EstadoDoRelogio, PedidoDoRelogio } from "./schemas";

// F17, T7: a tela do relógio da partida (só no modo partida) e o menu do admin.

const parado: EstadoDoRelogio = {
  instante: "2026-01-14T15:00:00.000Z",
  modo: "pausado",
  limite: "2026-11-15T04:33:00.000Z",
  aguardando: false,
  ultimoResultado: "2026-11-14T23:30:00.000Z",
  ocupado: null,
  dadosDe: "2026-11-15T03:00:00.000Z",
};

function api(estado: EstadoDoRelogio, pedidos: PedidoDoRelogio[] = [], erro?: string) {
  return {
    partida: async () => ({ partida: true as const, relogio: estado }),
    partidaRelogio: async (p: PedidoDoRelogio) => {
      pedidos.push(p);
      if (erro) throw new Error(erro);
      return { estado, avancou: true, mensagem: "avancei: 1 dia" };
    },
  } as unknown as AdminApi;
}

describe("tela do relógio da partida", () => {
  const dom = useDom();
  const mostrar = async (admin: AdminApi) => {
    await dom.render(createElement(RelogioScreen, { admin }));
    await dom.settle();
    await dom.settle();
  };
  const botao = (texto: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(texto)) as HTMLButtonElement | undefined;

  it("mostra o instante, o modo e o limite dos dados", async () => {
    await mostrar(api(parado));
    const texto = dom.text();
    expect(texto).toContain("Pausado");
    expect(texto).toContain("Agora no jogo");
    expect(texto).toContain("O relógio vai até");
    expect(botao("1 dia")?.disabled).toBe(false);
    expect(botao("Ligar o tempo real")).toBeDefined();
  });

  it("os botões pedem o salto certo", async () => {
    const pedidos: PedidoDoRelogio[] = [];
    await mostrar(api(parado, pedidos));
    botao("1 dia")!.click();
    await dom.settle();
    botao("Até a próxima rodada")!.click();
    await dom.settle();
    botao("Atualizar dados")!.click();
    await dom.settle();
    botao("Ligar o tempo real")!.click();
    await dom.settle();
    expect(pedidos).toEqual([{ acao: "dia" }, { acao: "rodada" }, { acao: "atualizar" }, { acao: "tempo-real" }]);
    expect(dom.text()).toContain("avancei: 1 dia");
  });

  it("7: no limite mostra 'aguardando resultados reais' com a data do último resultado e não deixa avançar", async () => {
    await mostrar(api({ ...parado, aguardando: true, instante: parado.limite! }));
    expect(dom.text()).toContain("Aguardando resultados reais");
    expect(dom.text()).toContain("último resultado em");
    expect(botao("1 dia")?.disabled).toBe(true);
    expect(botao("Até a próxima rodada")?.disabled).toBe(true);
    expect(botao("Atualizar dados")?.disabled).toBe(false);
  });

  it("em tempo real oferece pausar; com o relógio andando os saltos ficam desligados", async () => {
    await mostrar(api({ ...parado, modo: "tempo-real", ocupado: "1 dia" }));
    expect(dom.text()).toContain("Tempo real");
    expect(botao("Pausar")).toBeDefined();
    expect(botao("1 dia")?.disabled).toBe(true);
    expect(dom.text()).toContain("O relógio está andando: 1 dia");
  });

  it("18: com um salto andando a tela mostra o alvo e deixa pausar (o salto para ao fim da parada)", async () => {
    const pedidos: PedidoDoRelogio[] = [];
    await mostrar(api({ ...parado, ocupado: "avançando até 23/07, fim da rodada 19" }, pedidos));
    expect(dom.text()).toContain("O relógio está andando: avançando até 23/07, fim da rodada 19");
    expect(botao("1 dia")?.disabled).toBe(true);
    expect(botao("Pausar")?.disabled).toBe(false);
    botao("Pausar")!.click();
    await dom.settle();
    expect(pedidos).toEqual([{ acao: "pausar" }]);
  });

  it("10: a recusa da API aparece na tela ('o relógio já está andando')", async () => {
    await mostrar(api(parado, [], "o relógio já está andando"));
    botao("1 dia")!.click();
    await dom.settle();
    expect(dom.text()).toContain("o relógio já está andando");
  });
});
