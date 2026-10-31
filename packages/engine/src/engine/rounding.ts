/**
 * Arredondamento em inteiros para o dinheiro proporcional (custo que sai numa
 * venda, recompra de 1,5× etc.): nada passa por ponto flutuante.
 */

/**
 * ⌊a × b ÷ c⌉ com meio centavo para cima, só com inteiros não negativos.
 * O produto é feito em BigInt, porque custo × quantidade pode passar de 2^53.
 */
export function mulDivRound(a: number, b: number, c: number): number {
  for (const [value, label] of [
    [a, "a"],
    [b, "b"],
    [c, "divisor"],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${label} deve ser um inteiro não negativo, recebido ${value}`);
    }
  }
  if (c === 0) throw new Error("O divisor não pode ser zero");

  const divisor = BigInt(c);
  // Meio para cima: soma metade do divisor antes de dividir (2ab + c) ÷ 2c.
  const result = (BigInt(a) * BigInt(b) * 2n + divisor) / (2n * divisor);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("O resultado não cabe num inteiro seguro");
  }
  return Number(result);
}
