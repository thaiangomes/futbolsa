import { describe, expect, it } from "vitest";
import { compareReturns, equity, receivable, returnBp, returnRate } from "../src/engine/equity.js";
import { reais } from "../src/engine/money.js";

const at = (iso: string) => Date.parse(iso);

describe("patrimônio", () => {
  it("rankings 1: R$ 20.000,00 em caixa e 1.000 FLA3 a R$ 80,00 valem R$ 100.000,00", () => {
    expect(
      equity({ cash: reais(20_000), positions: [{ shares: 1_000, price: reais(80) }] }),
    ).toBe(reais(100_000));
  });

  it("rankings 12: clube sem negócio vale o preço do IPO que vier como preço", () => {
    expect(equity({ cash: 0, positions: [{ shares: 100, price: reais(12) }] })).toBe(reais(1_200));
  });

  it("rankings 13: caixa de −R$ 250,00 sem ações dá patrimônio −R$ 250,00 e retorno abaixo de −100%", () => {
    const e = equity({ cash: reais(-250), positions: [] });
    expect(e).toBe(reais(-250));
    expect(returnBp(e, reais(100_000))).toBe(-10_025);
    expect(returnBp(e, reais(100_000))).toBeLessThan(-10_000);
  });

  it("rankings 14: reserva de ordem não muda o patrimônio (o caixa total já a inclui)", () => {
    // R$ 5.000,00 do caixa de R$ 100.000,00 reservados numa compra aberta.
    expect(equity({ cash: reais(100_000), positions: [] })).toBe(reais(100_000));
  });

  it("carteira 13: R$ 58.360,00 em caixa e 1.200 FLA3 a R$ 44 dão R$ 111.160,00 (+11,16%)", () => {
    const e = equity({ cash: reais(58_360), positions: [{ shares: 1_200, price: reais(44) }] });
    expect(e).toBe(reais(111_160));
    expect(returnBp(e, reais(100_000))).toBe(1_116);
  });

  it("carteira 38: R$ 360,00 a receber somam R$ 111.520,00 e a aprovação não muda o patrimônio", () => {
    const posicoes = [{ shares: 1_200, price: reais(44) }];
    const antes = equity({ cash: reais(58_360), positions: posicoes, receivable: reais(360) });
    const depois = equity({ cash: reais(58_720), positions: posicoes, receivable: 0 });
    expect(antes).toBe(reais(111_520));
    expect(depois).toBe(reais(111_520));
  });

  it("rankings 23: com a recompra fechada as ações valem R$ 0,00 e conta só a recompra a receber", () => {
    const posicoes = [{ shares: 1_000, price: reais(60) }];
    const aReceber = reais(59_100); // 1.000 × R$ 59,10
    const fechada = equity({ cash: reais(1_000), positions: posicoes, receivable: aReceber, buybackClosed: true });
    expect(fechada).toBe(reais(1_000) + aReceber);
    // Aprovada: o caixa sobe R$ 59.100,00, o a receber zera, o patrimônio não muda.
    const aprovada = equity({ cash: reais(1_000) + aReceber, positions: posicoes, receivable: 0, buybackClosed: true });
    expect(aprovada).toBe(fechada);
  });

  it("carteira 17: estorno entra negativo no patrimônio", () => {
    expect(equity({ cash: reais(150 - 400), positions: [{ shares: 0, price: reais(44) }] })).toBe(reais(-250));
  });
});

describe("a receber num instante", () => {
  const fechamentoJunho = at("2027-06-30T20:00:00-03:00");
  const item = { closedAt: fechamentoJunho, perShare: 30, shares: 1_000, credited: 0 };

  it("rankings 9: R$ 300,00 de evento fechado às 20h contam em 30/06 às 23h59", () => {
    expect(receivable(at("2027-06-30T23:59:00-03:00"), [item])).toBe(reais(300));
  });

  it("rankings 9: depois da aprovação em julho o a receber zera e não conta de novo", () => {
    const aprovado = { ...item, credited: reais(300) };
    expect(receivable(at("2027-07-31T23:59:00-03:00"), [aprovado])).toBe(0);
  });

  it("rankings 9: a aprovação de 01/07 ainda não tinha caído no caixa em 30/06, então o a receber de junho continua R$ 300,00", () => {
    // Quem chama passa em `credited` só o que caiu no caixa até o instante.
    expect(receivable(at("2027-06-30T23:59:00-03:00"), [{ ...item, credited: 0 }])).toBe(reais(300));
  });

  it("evento que fecha depois do instante não conta", () => {
    expect(receivable(at("2027-06-30T19:59:00-03:00"), [item])).toBe(0);
  });

  it("evento que fecha exatamente no instante conta", () => {
    expect(receivable(fechamentoJunho, [item])).toBe(reais(300));
  });

  it("soma vários eventos e aceita crédito parcial", () => {
    const outro = { closedAt: at("2027-06-10T22:00:00-03:00"), perShare: 10, shares: 500, credited: 2_000 };
    expect(receivable(at("2027-06-30T23:59:00-03:00"), [item, outro])).toBe(reais(300) + 5_000 - 2_000);
  });

  it("crédito maior que o devido (estorno ainda não refletido) dá a receber negativo", () => {
    expect(receivable(fechamentoJunho, [{ ...item, credited: reais(400) }])).toBe(reais(-100));
  });

  it("lista vazia é zero", () => {
    expect(receivable(fechamentoJunho, [])).toBe(0);
  });
});

describe("retorno exato", () => {
  it("rankings 2: de R$ 112.000,00 a R$ 120.960,00 é +8,00%", () => {
    expect(returnBp(reais(120_960), reais(112_000))).toBe(800);
  });

  it("rankings 3: no primeiro mês a base é R$ 100.000,00 e quem não mexeu fica em 0,00%", () => {
    expect(returnBp(reais(100_000), reais(100_000))).toBe(0);
  });

  it("frações equivalentes são exatamente iguais", () => {
    const a = returnRate(reais(105), reais(100));
    const b = returnRate(reais(2_100), reais(2_000));
    expect(compareReturns(a, b)).toBe(0);
  });

  it("compara sem dividir: retornos que só diferem na vigésima casa", () => {
    // 10^12 centavos de base: a diferença de 1 centavo só aparece na comparação exata.
    const base = 1_000_000_000_000;
    expect(compareReturns(returnRate(base + 1, base), returnRate(base, base))).toBe(1);
    expect(compareReturns(returnRate(base - 1, base), returnRate(base, base))).toBe(-1);
  });

  it("returnBp arredonda meio ponto-base para longe do zero", () => {
    expect(returnBp(10_005, 10_000)).toBe(5); // +0,05%
    expect(returnBp(20_001, 20_000)).toBe(1); // 0,5 ponto-base sobe
    expect(returnBp(19_999, 20_000)).toBe(-1); // −0,5 desce (para longe do zero)
  });

  it("recusa base zero ou negativa e valores não inteiros", () => {
    expect(() => returnRate(reais(100), 0)).toThrow();
    expect(() => returnRate(reais(100), -1)).toThrow();
    expect(() => returnRate(100.5, 100)).toThrow();
  });
});
