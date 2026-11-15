/** Centavos como a tela mostra (`R$ 1.234,56`), com o espaço comum no lugar do inseparável, para comparar texto. */
export function reais(centavos: number): string {
  return `R$ ${(centavos / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** O texto de um elemento com todos os espaços (inclusive o inseparável) trocados por um espaço simples. */
export function limpo(texto: string | null | undefined): string {
  return (texto ?? "").replace(/\s+/g, " ").trim();
}

/** Reais como se digita num campo (`40,00`). */
export function campo(centavos: number): string {
  return (centavos / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
