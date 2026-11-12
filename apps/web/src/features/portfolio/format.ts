/** Formatos da carteira e dos gráficos. O site só formata: nenhuma conta de dinheiro acontece no navegador. */

/** Reais com vírgula a partir de centavos (`R$ 1.500,00`); negativo com o sinal na frente (`−R$ 250,00`). */
export function formatMoney(cents: number): string {
  const abs = (Math.abs(cents) / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${cents < 0 ? "−" : ""}R$ ${abs}`;
}

/** Com sinal explícito, para resultado e variação (`+R$ 2.400,00`, `−R$ 1.400,00`, `R$ 0,00`). */
export function formatSignedMoney(cents: number): string {
  if (cents === 0) return formatMoney(0);
  return `${cents > 0 ? "+" : ""}${formatMoney(cents)}`;
}

/** Centésimos de ponto percentual (1116 = 11,16%) com sinal e seta: `▲ +11,16%`, `▼ −5,00%` ou `0,00%`. */
export function formatBp(bp: number): string {
  const pct = (Math.abs(bp) / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (bp > 0) return `▲ +${pct}%`;
  if (bp < 0) return `▼ −${pct}%`;
  return `${pct}%`;
}

/** Décimos de ponto percentual (475 = 47,5%), com sinal e seta quando `signed`; sem seta, o número simples (`47,5%`). */
export function formatPermille(permille: number, signed = false): string {
  const pct = (Math.abs(permille) / 10).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (!signed) return `${permille < 0 ? "−" : ""}${pct}%`;
  if (permille > 0) return `▲ +${pct}%`;
  if (permille < 0) return `▼ −${pct}%`;
  return `${pct}%`;
}

/** A classe de cor de um valor com sinal: verde e vermelho só para alta e baixa. */
export function toneClass(value: number): "up" | "down" | "muted" {
  return value > 0 ? "up" : value < 0 ? "down" : "muted";
}

const BRASILIA = "America/Sao_Paulo";

/** Hora de Brasília a partir de segundos desde 1970 (o tempo das séries do gráfico): `16:15`. */
export function formatChartClock(seconds: number): string {
  return new Date(seconds * 1000).toLocaleTimeString("pt-BR", { timeZone: BRASILIA, hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Dia e mês de Brasília a partir de segundos: `06/04`. */
export function formatChartDay(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString("pt-BR", { timeZone: BRASILIA, day: "2-digit", month: "2-digit" });
}

/** Dia, mês e hora de Brasília para o cursor do gráfico: `06/04 16:15`. */
export function formatChartDateTime(seconds: number): string {
  return `${formatChartDay(seconds)} ${formatChartClock(seconds)}`;
}

/** `2027-04-06` como `06/04`. */
export function formatIsoDay(day: string): string {
  const [, month, d] = day.split("-");
  return `${d}/${month}`;
}

/** O mês `2027-05` como `maio de 2027`. */
export function formatMonth(month: string): string {
  const [year, m] = month.split("-");
  const name = new Date(Date.UTC(Number(year), Number(m) - 1, 1)).toLocaleDateString("pt-BR", { timeZone: "UTC", month: "long" });
  return `${name} de ${year}`;
}

/** Ações com ponto de milhar (`1.200`). */
export function formatShares(n: number): string {
  return n.toLocaleString("pt-BR", { maximumFractionDigits: 0 });
}
