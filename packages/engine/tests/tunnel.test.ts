import { describe, expect, it } from "vitest";
import { dayStart } from "../src/engine/brasilia.js";
import { reais } from "../src/engine/money.js";
import { AUCTION_DURATION_MS, breachesTunnel, rollTunnelReference, TUNNEL_BP, tunnelBand } from "../src/engine/tunnel.js";

// Critérios 39, 43 e 44 de "Livro de ofertas e formador de mercado" (túnel de preço e leilão) e as decisões
// D1 e D4 do Plano do livro de ofertas e formador.

const at = (iso: string) => Date.parse(iso);

describe("constantes", () => {
  it("o túnel é de 10% e o leilão dura 3 horas (P13)", () => {
    expect(TUNNEL_BP).toBe(1000);
    expect(AUCTION_DURATION_MS).toBe(3 * 60 * 60 * 1000);
  });
});

describe("tunnelBand", () => {
  it("livro 39: com a referência em R$ 40,00 o túnel vai de R$ 36,00 a R$ 44,00", () => {
    expect(tunnelBand(reais(40))).toEqual({ min: reais(36), max: reais(44) });
  });

  it("livro 43: com R$ 7,00 vai de R$ 6,30 a R$ 7,70", () => {
    expect(tunnelBand(reais(7))).toEqual({ min: 630, max: 770 });
  });

  it("arredonda para dentro do túnel e respeita o piso de R$ 0,50", () => {
    // 4333 × 0,9 = 3899,7 → 3900 (para cima); 4333 × 1,1 = 4766,3 → 4766 (para baixo)
    expect(tunnelBand(4333)).toEqual({ min: 3900, max: 4766 });
    // 55 × 0,9 = 49,5 → 50 (já é o piso); 55 × 1,1 = 60,5 → 60
    expect(tunnelBand(55)).toEqual({ min: 50, max: 60 });
    expect(tunnelBand(50).min).toBe(50);
  });

  it("recusa preço que não é inteiro em centavos", () => {
    expect(() => tunnelBand(40.5)).toThrow();
  });
});

describe("breachesTunnel", () => {
  const band = tunnelBand(reais(40));

  it("o negócio na beira do túnel está dentro; um centavo fora, não", () => {
    expect(breachesTunnel([{ price: reais(44) }], band)).toBe(false);
    expect(breachesTunnel([{ price: reais(36) }], band)).toBe(false);
    expect(breachesTunnel([{ price: reais(44) + 1 }], band)).toBe(true);
    expect(breachesTunnel([{ price: reais(36) - 1 }], band)).toBe(true);
  });

  it("basta um negócio fora para a ordem inteira abrir o leilão", () => {
    // livro 39: Bruno a R$ 43,00 (dentro) e Davi a R$ 44,50 (fora)
    expect(breachesTunnel([{ price: 4300 }, { price: 4450 }], band)).toBe(true);
    expect(breachesTunnel([{ price: 4300 }], band)).toBe(false);
  });

  it("sem negócios, não sai do túnel", () => {
    expect(breachesTunnel([], band)).toBe(false);
  });
});

describe("rollTunnelReference", () => {
  const day1 = at("2027-04-05T13:00:00Z"); // 10h de Brasília
  const day2 = at("2027-04-06T03:00:00Z"); // 0h de Brasília do dia seguinte

  it("na estreia a referência é o preço exibido (o de corte do IPO)", () => {
    const next = rollTunnelReference({ reference: null, referenceDay: null, inAuction: false }, reais(35), day1);
    expect(next).toEqual({ reference: reais(35), referenceDay: dayStart(day1), changed: true });
  });

  it("no mesmo dia a referência não muda, mesmo com o preço exibido andando", () => {
    const state = { reference: reais(40), referenceDay: dayStart(day1), inAuction: false };
    const next = rollTunnelReference(state, reais(43), day1 + 3_600_000);
    expect(next).toEqual({ reference: reais(40), referenceDay: dayStart(day1), changed: false });
  });

  it("livro 44: às 0h o FLA3 vira para R$ 44,50 e o PAL3, em leilão, continua em R$ 30,00", () => {
    const fla = rollTunnelReference({ reference: reais(40), referenceDay: dayStart(day1), inAuction: false }, 4450, day2);
    expect(fla).toEqual({ reference: 4450, referenceDay: dayStart(day2), changed: true });
    const pal = rollTunnelReference({ reference: reais(30), referenceDay: dayStart(day1), inAuction: true }, reais(30), day2);
    expect(pal).toEqual({ reference: reais(30), referenceDay: dayStart(day1), changed: false });
  });

  it("a virada de dia é às 3h UTC (0h de Brasília), não às 0h UTC", () => {
    const state = { reference: reais(40), referenceDay: dayStart(day1), inAuction: false };
    expect(rollTunnelReference(state, 4100, at("2027-04-06T02:59:59Z")).changed).toBe(false);
    expect(rollTunnelReference(state, 4100, at("2027-04-06T03:00:00Z")).changed).toBe(true);
  });

  it("D4: leilão que passou das 0h e acabou sem negócio mantém a referência até as 0h seguintes", () => {
    // o fim do leilão grava `referenceDay` = hoje sem mudar a referência; no dia seguinte vira de novo
    const afterAuction = { reference: reais(40), referenceDay: dayStart(day2), inAuction: false };
    expect(rollTunnelReference(afterAuction, 4100, day2 + 3_600_000).changed).toBe(false);
    expect(rollTunnelReference(afterAuction, 4100, day2 + 24 * 3_600_000).reference).toBe(4100);
  });
});
