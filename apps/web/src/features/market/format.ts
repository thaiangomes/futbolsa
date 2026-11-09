import type { AuctionState } from "@futbolsa/contracts";

/** Variação em centésimos de ponto percentual como a tela mostra: `▲ +3,02%`, `▼ −5,00%` ou `0,00%`. */
export function formatChange(changeBp: number): string {
  const pct = (Math.abs(changeBp) / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (changeBp > 0) return `▲ +${pct}%`;
  if (changeBp < 0) return `▼ −${pct}%`;
  return `${pct}%`;
}

/** A cor da variação: sobe, desce ou parada (verde e vermelho só para alta e baixa, sempre com sinal). */
export function changeClass(changeBp: number): "up" | "down" | "muted" {
  return changeBp > 0 ? "up" : changeBp < 0 ? "down" : "muted";
}

/** Hora de Brasília, `16:14`. */
export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Hora de Brasília no texto do aviso, `15h40`. */
export function formatHour(iso: string): string {
  return formatClock(iso).replace(":", "h");
}

/** O aviso "em leilão até 15h40", ou o do leilão parado pela suspensão (sem hora). `null` fora de leilão. */
export function auctionNotice(auction: AuctionState | null): string | null {
  if (!auction) return null;
  return auction.until ? `Em leilão até ${formatHour(auction.until)}` : "Leilão parado pela suspensão";
}
