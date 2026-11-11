import type { MarketMakerBody, MarketMakerState, MarketMakerTreasury } from "@futbolsa/contracts";

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

/** Quantas ações a casa cota por lado: a regra do motor (`quoteSize`), repetida aqui porque o site não importa o motor. */
export function sideQuantity(totalShares: number, basisPoints: number, minimum: number): { quantity: number; raw: number; usesMinimum: boolean } {
  const raw = Math.floor((totalShares * basisPoints) / 10_000);
  const quantity = Math.max(raw, minimum, 1);
  return { quantity, raw, usesMinimum: raw < minimum || raw < 1 };
}

/** "10 por lado (0,25% dá 9; vale o mínimo)", como na prancha. */
export function describeSide(totalShares: number, basisPoints: number, minimum: number): string {
  const { quantity, raw, usesMinimum } = sideQuantity(totalShares, basisPoints, minimum);
  const base = `${quantity.toLocaleString("pt-BR")} por lado`;
  return usesMinimum ? `${base} (${formatPercent(basisPoints)}% dá ${raw.toLocaleString("pt-BR")}; vale o mínimo)` : base;
}

/** A coluna "A casa cota" do quadro da tesouraria. */
export function quoteNote(club: Pick<MarketMakerTreasury["clubs"][number], "ticker" | "freeShares" | "status">, freeCash: number): string {
  if (club.status === "suspended") return "Nada: a casa não cota clube suspenso";
  const noShares = club.freeShares <= 0;
  const noCash = freeCash <= 0;
  const base = noShares && noCash
    ? "Nada: a tesouraria está sem ações livres e sem caixa"
    : noShares
      ? `Só compra: a tesouraria está sem ações livres do ${club.ticker}`
      : noCash
        ? "Só vende: a tesouraria está sem caixa livre"
        : "Compra e venda";
  if (club.status === "auction") return `${base}; a oferta da casa entra no preço único do leilão`;
  if (club.status === "in_match") return `${base}, com a quantidade do modo de jogo`;
  return base;
}
