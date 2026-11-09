import { bidReserve as engineBidReserve } from "@futbolsa/engine";
import { IPO_ERROR_MESSAGES } from "@futbolsa/contracts";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import { applyBidCancelled, applyBidSaved, bidPreview, bidReserve, formatCountdown, ipoErrorMessage, parseQuantity, parseReais } from "./forms";
import { CASH_FREE, FLA3, openOverview } from "./test-fixtures";

describe("oferta do IPO (contas da tela)", () => {
  it("ipo 8: 1.500 ações até R$ 40 reservam R$ 60.000 e deixam R$ 40.000 livres", () => {
    const preview = bidPreview({ quantity: "1500", maxPrice: "40", band: FLA3.band, freeCash: CASH_FREE.free, currentReserve: 0 });
    expect(preview).toMatchObject({ ok: true, quantity: 1500, maxPrice: 4000, effectivePrice: 4000, reserve: 6_000_000, aboveCeiling: false, freeAfter: 4_000_000 });
  });

  it("ipo 9: 100 ações até R$ 90 com teto de R$ 70,77 reservam R$ 7.077 (o preço vale como o teto)", () => {
    const preview = bidPreview({ quantity: "100", maxPrice: "90", band: FLA3.band, freeCash: CASH_FREE.free, currentReserve: 0 });
    expect(preview).toMatchObject({ ok: true, maxPrice: 9000, effectivePrice: 7077, reserve: 707_700, aboveCeiling: true });
  });

  it("ipo 13: editar conta a reserva atual da própria oferta como livre", () => {
    // 1.500 até R$ 40 (R$ 60.000 reservados, R$ 40.000 livres) editada para 1.000 até R$ 38
    const preview = bidPreview({ quantity: "1000", maxPrice: "38", band: FLA3.band, freeCash: 4_000_000, currentReserve: 6_000_000 });
    expect(preview).toMatchObject({ ok: true, reserve: 3_800_000, freeAfter: 6_200_000 });
  });

  it("a reserva da tela é a mesma conta do motor (quantidade × menor valor entre o preço máximo e o teto)", () => {
    let seed = 20271;
    const next = (max: number) => {
      seed = (seed * 48271) % 2147483647;
      return (seed % max) + 1;
    };
    for (let i = 0; i < 2000; i++) {
      const band = { floor: next(5000), ceiling: 5000 + next(20000) };
      const quantity = next(5000);
      const maxPrice = next(40000);
      expect(bidReserve(quantity, maxPrice, band)).toBe(engineBidReserve(quantity, maxPrice, band));
    }
  });

  it("quantidade: só inteiro de 1 em diante; senão a mensagem do código invalid_quantity", () => {
    expect(parseQuantity("1500")).toBe(1500);
    for (const bad of ["", "0", "-3", "10,5", "1e3", "abc", " "]) expect(parseQuantity(bad)).toBeNull();
    const preview = bidPreview({ quantity: "10,5", maxPrice: "40", band: FLA3.band, freeCash: 1_000_000, currentReserve: 0 });
    expect(preview).toMatchObject({ ok: false, quantityError: IPO_ERROR_MESSAGES.invalid_quantity, priceError: null });
  });

  it("preço em reais vira centavos; mais de duas casas ou zero é invalid_price", () => {
    expect(parseReais("40")).toBe(4000);
    expect(parseReais("40,5")).toBe(4050);
    expect(parseReais("40.50")).toBe(4050);
    expect(parseReais("R$ 30,33")).toBe(3033);
    expect(parseReais("1.234,56")).toBe(123_456);
    expect(parseReais("0,01")).toBe(1);
    for (const bad of ["", "abc", "40,555", "-1", "4 0"]) expect(parseReais(bad)).toBeNull();
    expect(bidPreview({ quantity: "10", maxPrice: "40,555", band: FLA3.band, freeCash: 1_000_000, currentReserve: 0 })).toMatchObject({ ok: false, priceError: IPO_ERROR_MESSAGES.invalid_price });
    expect(bidPreview({ quantity: "10", maxPrice: "0", band: FLA3.band, freeCash: 1_000_000, currentReserve: 0 })).toMatchObject({ ok: false, priceError: IPO_ERROR_MESSAGES.invalid_price });
  });

  it("a contagem regressiva mostra só as unidades que importam", () => {
    expect(formatCountdown(6 * 86_400_000 + 23 * 3_600_000 + 12 * 60_000 + 5000)).toBe("6 d 23 h 12 min 5 s");
    expect(formatCountdown(3 * 3_600_000 + 4 * 60_000 + 9000)).toBe("3 h 4 min 9 s");
    expect(formatCountdown(65_000)).toBe("1 min 5 s");
    expect(formatCountdown(0)).toBe("0 s");
    expect(formatCountdown(-5000)).toBe("0 s");
  });

  it("a recusa usa a mensagem do contrato pelo código, não o texto que veio na resposta", () => {
    for (const code of Object.keys(IPO_ERROR_MESSAGES) as Array<keyof typeof IPO_ERROR_MESSAGES>) {
      expect(ipoErrorMessage(new ApiError(422, code, "texto do servidor"))).toBe(IPO_ERROR_MESSAGES[code]);
    }
    expect(ipoErrorMessage(new ApiError(500, "outro_codigo", "mensagem da API"))).toBe("mensagem da API");
    expect(ipoErrorMessage(new Error("sem rede"))).toBe("sem rede");
    expect(ipoErrorMessage("x")).toBe("Algo deu errado. Tente de novo.");
  });

  it("depois de salvar ou cancelar, a tela usa o caixa que a API devolveu", () => {
    const bid = { quantity: 1500, maxPrice: 4000, reserved: 6_000_000, updatedAt: "2027-03-30T15:00:00.000Z" };
    const cash = { total: 10_000_000, reserved: 6_000_000, free: 4_000_000 };
    const saved = applyBidSaved(openOverview(), "FLA3", bid, cash);
    expect(saved.clubs.find((c) => c.ticker === "FLA3")?.myBid).toEqual(bid);
    expect(saved.clubs.find((c) => c.ticker === "PAL3")?.myBid).toBeNull();
    expect(saved.cash).toEqual(cash);
    const cancelled = applyBidCancelled(saved, "FLA3", CASH_FREE);
    expect(cancelled.clubs.find((c) => c.ticker === "FLA3")?.myBid).toBeNull();
    expect(cancelled.cash).toEqual(CASH_FREE);
  });
});
