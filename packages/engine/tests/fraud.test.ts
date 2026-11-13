import { describe, expect, it } from "vitest";
import { reais } from "../src/engine/money.js";
import {
  FRAUD_ALERT_MIN_TRADES,
  FRAUD_ALERT_WINDOW_MS,
  FRAUD_MAX_SHARES,
  findFraudAlerts,
  isSuspiciousTrade,
  type FraudTrade,
} from "../src/engine/fraud.js";

// Critérios 39 e 40 de "Admin" (trapaça entre contas) e os números da rodada X de Calibração.

const T0 = Date.parse("2026-08-03T15:00:00Z");
const HOUR = 60 * 60 * 1000;

let seq = 0;
function trade(p: Partial<FraudTrade> & { price: number; priceBefore: number }): FraudTrade {
  seq += 1;
  return {
    id: seq,
    at: T0,
    clubId: 1,
    buyerWallet: 10,
    sellerWallet: 20,
    quantity: 1,
    withHouse: false,
    ...p,
  };
}

describe("isSuspiciousTrade", () => {
  it("constantes: até 10 ações e 3 negócios em 7 dias", () => {
    expect(FRAUD_MAX_SHARES).toBe(10);
    expect(FRAUD_ALERT_MIN_TRADES).toBe(3);
    expect(FRAUD_ALERT_WINDOW_MS).toBe(7 * 24 * HOUR);
  });

  it("admin 39: 1 SPT3 a R$ 7,70 contra R$ 7,00 é suspeito (10%)", () => {
    expect(isSuspiciousTrade(trade({ price: 770, priceBefore: reais(7) }))).toBe(true);
  });

  it("admin 40: 10 ações é suspeito e 11 não", () => {
    expect(isSuspiciousTrade(trade({ quantity: 10, price: 770, priceBefore: 700 }))).toBe(true);
    expect(isSuspiciousTrade(trade({ quantity: 11, price: 770, priceBefore: 700 }))).toBe(false);
  });

  it("admin 40: exatamente 5% é suspeito e 4,99% não", () => {
    expect(isSuspiciousTrade(trade({ price: 735, priceBefore: 700 }))).toBe(true);
    expect(isSuspiciousTrade(trade({ price: 734, priceBefore: 700 }))).toBe(false);
    // em centavos inteiros: 4,99% de R$ 100,00 = R$ 104,99
    expect(isSuspiciousTrade(trade({ price: 10_499, priceBefore: 10_000 }))).toBe(false);
    expect(isSuspiciousTrade(trade({ price: 10_500, priceBefore: 10_000 }))).toBe(true);
  });

  it("queda de 5% também é suspeita", () => {
    expect(isSuspiciousTrade(trade({ price: 665, priceBefore: 700 }))).toBe(true);
    expect(isSuspiciousTrade(trade({ price: 666, priceBefore: 700 }))).toBe(false);
  });

  it("negócio com a casa nunca é suspeito", () => {
    expect(isSuspiciousTrade(trade({ withHouse: true, price: 900, priceBefore: 700 }))).toBe(false);
  });

  it("preço anterior zero não gera divisão nem suspeita", () => {
    expect(isSuspiciousTrade(trade({ price: 100, priceBefore: 0 }))).toBe(false);
  });
});

describe("findFraudAlerts", () => {
  const sus = (offsetHours: number, over: Partial<FraudTrade> = {}) =>
    trade({ at: T0 + offsetHours * HOUR, price: 770, priceBefore: 700, ...over });

  it("admin 39: SPT3 a R$ 7,70, R$ 8,47 e R$ 9,31 entre Ana e Bruno dão alerta no 3º", () => {
    const a = trade({ at: T0, price: 770, priceBefore: 700 });
    const b = trade({ at: T0 + HOUR, price: 847, priceBefore: 770 });
    const c = trade({ at: T0 + 2 * HOUR, price: 931, priceBefore: 847 });
    expect(findFraudAlerts([a, b])).toEqual([]);
    const alerts = findFraudAlerts([a, b, c]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      clubId: 1,
      walletLow: 10,
      walletHigh: 20,
      tradeIds: [a.id, b.id, c.id],
      firstAt: T0,
      lastAt: T0 + 2 * HOUR,
    });
  });

  it("admin 40: 15 negócios de mais de 10 ações ou com menos de 5% não dão alerta", () => {
    const trades: FraudTrade[] = [];
    for (let i = 0; i < 8; i++) trades.push(sus(i, { quantity: 11 }));
    for (let i = 0; i < 7; i++) trades.push(trade({ at: T0 + i * HOUR, price: 710, priceBefore: 700 }));
    expect(findFraudAlerts(trades)).toEqual([]);
  });

  it("2 suspeitos não dão alerta", () => {
    expect(findFraudAlerts([sus(0), sus(1)])).toEqual([]);
  });

  it("do 1º ao 3º em exatamente 7 × 24 horas dá alerta e um minuto a mais não", () => {
    const edge = [sus(0), sus(24), sus(7 * 24)];
    expect(findFraudAlerts(edge)).toHaveLength(1);
    const over = [sus(0), sus(24), trade({ at: T0 + 7 * 24 * HOUR + 60_000, price: 770, priceBefore: 700 })];
    expect(findFraudAlerts(over)).toEqual([]);
  });

  it("clubes diferentes não somam", () => {
    expect(findFraudAlerts([sus(0, { clubId: 1 }), sus(1, { clubId: 2 }), sus(2, { clubId: 1 })])).toEqual([]);
  });

  it("par invertido (Bruno compra de Ana) é o mesmo par", () => {
    const alerts = findFraudAlerts([
      sus(0),
      sus(1, { buyerWallet: 20, sellerWallet: 10 }),
      sus(2),
    ]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.walletLow).toBe(10);
    expect(alerts[0]!.walletHigh).toBe(20);
  });

  it("pares diferentes não somam", () => {
    expect(findFraudAlerts([sus(0), sus(1, { sellerWallet: 30 }), sus(2)])).toEqual([]);
  });

  it("negócio com a casa nunca conta", () => {
    expect(findFraudAlerts([sus(0), sus(1, { withHouse: true }), sus(2)])).toEqual([]);
  });

  it("o 4º suspeito entra no mesmo alerta; um negócio comum no meio fica de fora", () => {
    const plain = trade({ at: T0 + 90 * 60_000, price: 705, priceBefore: 700 });
    const alerts = findFraudAlerts([sus(0), sus(1), plain, sus(2), sus(3)]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.tradeIds).toHaveLength(4);
    expect(alerts[0]!.tradeIds).not.toContain(plain.id);
  });

  it("dois pares no mesmo clube dão dois alertas, em ordem estável", () => {
    const other = (h: number) => sus(h, { buyerWallet: 5, sellerWallet: 6 });
    const alerts = findFraudAlerts([sus(0), other(0), sus(1), other(1), sus(2), other(2)]);
    expect(alerts.map((a) => a.walletLow)).toEqual([5, 10]);
  });

  it("não depende da ordem de entrada", () => {
    const list = [sus(2), sus(0), sus(1)];
    expect(findFraudAlerts(list)[0]!.tradeIds).toEqual(findFraudAlerts([...list].reverse())[0]!.tradeIds);
  });
});
