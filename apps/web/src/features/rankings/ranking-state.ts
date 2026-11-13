import type { LiveRanking, RankingRow, RankingsLiveEvent } from "@futbolsa/contracts";

/** "2º": o empate mostra a mesma posição nas duas linhas e a seguinte pula (1º, 2º, 2º, 4º); o servidor já manda a posição assim. */
export const positionLabel = (position: number): string => `${position}º`;

/** "+8,00%", "−1,50%", "0,00%"; "—" para quem está sem base (retorno nulo). */
export function returnLabel(returnBp: number | null): string {
  if (returnBp === null) return "—";
  const sign = returnBp > 0 ? "+" : returnBp < 0 ? "−" : "";
  const abs = Math.abs(returnBp);
  const text = `${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
  return `${sign}${text}%`;
}

/** Quem a linha mostra: o apelido, o rótulo do bot ou "conta excluída". */
export function rowName(row: Pick<RankingRow, "displayName" | "isBot" | "botLabel">): string {
  if (row.displayName) return row.displayName;
  return row.isBot ? (row.botLabel ?? "Bot") : "conta excluída";
}

const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

/** "2027-06" → "junho de 2027". */
export function monthLabel(key: string): string {
  const [year, month] = key.split("-");
  const name = MONTHS[Number(month) - 1];
  return name ? `${name} de ${year}` : key;
}

/** O mês escolhido vem da query (`?mes=2027-06`); qualquer outra coisa vira nada. */
export function monthFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get("mes");
  return value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : null;
}

/** A query de volta: o mês escolhido (ou nenhum). */
export function searchForMonth(month: string | null): string {
  return month ? `?mes=${month}` : "";
}

/**
 * Aplica o evento `rankings.live` à parcial carregada: só do mesmo período e só se o cálculo for mais novo que o da carga
 * (um evento atrasado é descartado). Troca o topo da primeira página, o total e a hora do cálculo; a linha de quem
 * pediu e as outras páginas continuam as da última leitura (a tela relê quando mudam).
 */
export function applyLiveEvent(state: LiveRanking, event: RankingsLiveEvent): LiveRanking {
  if (event.period !== state.period) return state;
  if (Date.parse(event.computedAt) <= Date.parse(state.computedAt)) return state;
  const rows = state.offset === 0 ? [...event.top, ...state.rows.slice(event.top.length)].slice(0, Math.max(state.rows.length, event.top.length)) : state.rows;
  return { ...state, computedAt: event.computedAt, total: event.total, rows };
}
