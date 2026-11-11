/**
 * A porta do horário e da suspensão (Livro de ofertas, "Horário de negociação" e Admin, critérios 23 e 24):
 * recebe as linhas da temporada e do clube lidas **depois** da trava do clube e o relógio, e diz se uma ordem
 * nova pode entrar. Pura: nada de banco aqui.
 *
 * - `market_closed`: a negociação ainda não abriu (a temporada só vai a `trading` na abertura, às 10h de Brasília
 *   do dia seguinte ao fechamento do IPO, depois da liquidação), já acabou (`trading_ended` e `closed`, ou
 *   `trading_ended_at` gravado) ou o instante é anterior à abertura.
 * - `club_suspended`: clube suspenso ou mercado todo suspenso, com o motivo, que todos veem.
 * Cancelar uma ordem continua aceito com o clube suspenso: quem cancela não passa por esta porta.
 */
export interface GateSeason {
  status: string;
  tradingOpensAt: Date | null;
  tradingEndedAt: Date | null;
  suspendedReason: string | null;
}

export type TradingGate = { open: true } | { open: false; code: "market_closed" } | { open: false; code: "club_suspended"; reason: string };

export function tradingGate(season: GateSeason, club: { suspendedReason: string | null }, now: Date): TradingGate {
  const t = now.getTime();
  const closed = { open: false, code: "market_closed" } as const;
  if (season.status !== "trading") return closed;
  if (season.tradingOpensAt === null || t < season.tradingOpensAt.getTime()) return closed;
  if (season.tradingEndedAt !== null && t >= season.tradingEndedAt.getTime()) return closed;
  if (season.suspendedReason !== null) return { open: false, code: "club_suspended", reason: season.suspendedReason };
  if (club.suspendedReason !== null) return { open: false, code: "club_suspended", reason: club.suspendedReason };
  return { open: true };
}
