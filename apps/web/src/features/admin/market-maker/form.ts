import type { MarketMakerBody, MarketMakerState } from "@futbolsa/contracts";

/** O que o admin digita na tela do formador (prancha 7l): percentuais em %, mínimos em ações. */
export interface MarketMakerForm {
  quantity: string;
  matchQuantity: string;
  minSide: string;
  matchMinSide: string;
}

/** "0,25" (ou "0.25") em pontos-base (25). Só até duas casas, maior que zero e no máximo 100%. */
export function parsePercent(text: string): number | null {
  const t = text.trim();
  if (!/^\d+([.,]\d{1,2})?$/.test(t)) return null;
  const bp = Math.round(parseFloat(t.replace(",", ".")) * 100);
  return bp > 0 && bp <= 10_000 ? bp : null;
}

/** Pontos-base em texto de percentual, como o admin digita: 25 -> "0,25", 100 -> "1", 150 -> "1,5". */
export function formatPercent(bp: number): string {
  return (bp / 100).toFixed(2).replace(".", ",").replace(/,00$/, "").replace(/(,\d)0$/, "$1");
}

/** Mínimo de ações por lado: inteiro de 1 em diante. */
export function parseMinimum(text: string): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = parseInt(t, 10);
  return n >= 1 ? n : null;
}

export function formOf(state: MarketMakerState): MarketMakerForm {
  return {
    quantity: formatPercent(state.mmQuantityBp),
    matchQuantity: formatPercent(state.mmMatchQuantityBp),
    minSide: String(state.mmMinSideQty),
    matchMinSide: String(state.mmMatchMinSideQty),
  };
}

/** Qual campo está inválido (para marcar em vermelho) e a mensagem que a prancha mostra. */
export function formErrors(form: MarketMakerForm): { invalid: Set<keyof MarketMakerForm>; message: string | null } {
  const invalid = new Set<keyof MarketMakerForm>();
  if (parsePercent(form.quantity) === null) invalid.add("quantity");
  if (parsePercent(form.matchQuantity) === null) invalid.add("matchQuantity");
  if (parseMinimum(form.minSide) === null) invalid.add("minSide");
  if (parseMinimum(form.matchMinSide) === null) invalid.add("matchMinSide");
  if (invalid.has("quantity") || invalid.has("matchQuantity")) {
    return { invalid, message: "O percentual precisa ser um número maior que zero, com até duas casas, como 0,25." };
  }
  if (invalid.size > 0) return { invalid, message: "O mínimo precisa ser um número inteiro de ações, 1 ou mais." };
  return { invalid, message: null };
}

/** Só o que mudou em relação ao que está em vigor; `null` se nada mudou ou se algum campo é inválido. */
export function changesOf(state: MarketMakerState, form: MarketMakerForm): Omit<MarketMakerBody, "reason"> | null {
  if (formErrors(form).message) return null;
  const next = {
    mmQuantityBp: parsePercent(form.quantity)!,
    mmMatchQuantityBp: parsePercent(form.matchQuantity)!,
    mmMinSideQty: parseMinimum(form.minSide)!,
    mmMatchMinSideQty: parseMinimum(form.matchMinSide)!,
  };
  const changed = Object.fromEntries(Object.entries(next).filter(([k, v]) => v !== state[k as keyof typeof next]));
  return Object.keys(changed).length > 0 ? changed : null;
}
