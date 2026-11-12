import { assertCents, type Cents } from "./money.js";

/**
 * Fatias da foto mensal da carteira ([[Carteira e gráficos]], critérios 30, 31 e 41): a fatia de cada clube e do caixa
 * em décimos de ponto percentual (475 = 47,5%), com a base de caixa mais valor das ações, **sem** o "a receber" (assim
 * a foto soma 100% e não revela dividendos). Pelo método da maior sobra, as fatias somam exatamente 1.000. O caixa
 * negativo (estorno) vira fatia negativa. Base zero ou negativa devolve `{}`. Fatias zeradas não entram.
 */
export const SLICES_TOTAL = 1000;

export interface SliceInput {
  cash: Cents;
  /** Valor a mercado de cada clube com ações (ações × preço exibido). */
  positions: readonly { ticker: string; value: Cents }[];
}

export function portfolioSlices({ cash, positions }: SliceInput): Record<string, number> {
  assertCents(cash, "caixa");
  const parts: { key: string; value: number }[] = [{ key: "cash", value: cash }];
  for (const p of positions) {
    assertCents(p.value, `valor de ${p.ticker}`);
    if (p.ticker === "cash") throw new Error('O ticker "cash" é reservado para o caixa');
    parts.push({ key: p.ticker, value: p.value });
  }
  const base = parts.reduce((sum, p) => sum + p.value, 0);
  if (base <= 0) return {};

  // Parte inteira (piso) e resto exato de cada fatia; o que falta para 1.000 vai a quem tem o maior resto.
  const rows = parts.map((p) => {
    const scaled = p.value * SLICES_TOTAL;
    const floor = Math.floor(scaled / base);
    return { key: p.key, value: p.value, floor, remainder: scaled - floor * base };
  });
  let left = SLICES_TOTAL - rows.reduce((sum, r) => sum + r.floor, 0);
  // empate decidido de forma estável: maior resto, depois maior valor, depois a chave
  const order = [...rows].sort((a, b) => b.remainder - a.remainder || b.value - a.value || a.key.localeCompare(b.key));
  for (const r of order) {
    if (left <= 0) break;
    if (r.remainder === 0) continue;
    r.floor += 1;
    left -= 1;
  }
  const out: Record<string, number> = {};
  for (const r of rows) if (r.floor !== 0) out[r.key] = r.floor;
  return out;
}
