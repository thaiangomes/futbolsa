/** Reais com vírgula, a partir de centavos (`R$ 1.500,00`). */
export function formatCents(cents: number): string {
  return `R$ ${(cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Data e hora de Brasília, como o resto do jogo mostra. */
export function formatInstant(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" });
}

/** Número inteiro com ponto de milhar (`3.000`). */
export function formatInt(value: number): string {
  return value.toLocaleString("pt-BR", { maximumFractionDigits: 0 });
}
