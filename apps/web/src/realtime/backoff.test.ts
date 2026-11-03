import { describe, expect, it } from "vitest";
import { Backoff } from "./backoff";

describe("recuo da reconexão (T8)", () => {
  it("C23: vai de 1 a 30 segundos dobrando a cada falha (sem sorteio: valor cheio)", () => {
    const backoff = new Backoff();
    const sempreMaximo = () => 1;
    const esperas = Array.from({ length: 8 }, () => backoff.next(sempreMaximo));
    expect(esperas).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
  });

  it("C23: o sorteio fica entre 50% e 100% do valor", () => {
    const minimo = new Backoff();
    expect(minimo.next(() => 0)).toBe(500);
    expect(minimo.next(() => 0)).toBe(1_000);
    const meio = new Backoff();
    expect(meio.next(() => 0.5)).toBe(750);
    // 1.000 sorteios nunca saem da faixa
    for (let i = 0; i < 1_000; i++) {
      const backoff = new Backoff();
      for (let falha = 0; falha < 8; falha++) {
        const cheio = Math.min(30_000, 1_000 * 2 ** falha);
        const espera = backoff.next();
        expect(espera).toBeGreaterThanOrEqual(cheio * 0.5);
        expect(espera).toBeLessThanOrEqual(cheio);
      }
    }
  });

  it("C23: volta a 1 segundo depois de uma conexão que se manteve aberta", () => {
    const backoff = new Backoff();
    for (let i = 0; i < 5; i++) backoff.next(() => 1);
    expect(backoff.next(() => 1)).toBe(30_000);
    backoff.reset();
    expect(backoff.next(() => 1)).toBe(1_000);
  });

  it("falhas muito seguidas não estouram o teto", () => {
    const backoff = new Backoff();
    for (let i = 0; i < 2_000; i++) backoff.next(() => 1);
    expect(backoff.next(() => 1)).toBe(30_000);
  });
});
