/**
 * Todo valor em dinheiro do motor é um inteiro em centavos, para não acumular
 * erro de ponto flutuante em saldos, preços e dividendos.
 */
export type Cents = number;

export const reais = (value: number): Cents => Math.round(value * 100);

/** Preço mínimo de qualquer ação (regra de segurança do plano): R$ 0,50. */
export const MIN_PRICE: Cents = 50;

export function formatBRL(cents: Cents): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const intPart = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const frac = (abs % 100).toString().padStart(2, "0");
  return `${sign}R$ ${intPart},${frac}`;
}

export function assertCents(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new Error(`${label} deve ser um inteiro em centavos, recebido ${value}`);
  }
}
