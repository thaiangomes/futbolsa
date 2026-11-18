import type { LiveGame, LiveGames } from "@futbolsa/contracts";
import { FIXTURE_COMPETITIONS } from "@futbolsa/contracts";
import { gameMinute, type LiveMatch } from "@futbolsa/engine";

/** Um jogo como o banco guarda, com os dois clubes já resolvidos. */
export interface GameRow {
  competition: string;
  round: number | null;
  phase: string | null;
  kickoff: Date;
  status: string;
  homeGoals: number | null;
  awayGoals: number | null;
  home: { ticker: string | null; name: string };
  away: { ticker: string | null; name: string };
}

export interface PriceInfo {
  price: number;
  changeBp: number;
}

/** Depois de quanto tempo do início o jogo sem resultado deixa de contar como "em andamento" (jogo com mais de 4 h é atraso da fonte, não bola rolando). */
export const LIVE_WINDOW_MS = 4 * 3_600_000;

/**
 * Separa os jogos da temporada em andamento, de mais tarde e encerrados (a regra da faixa: ela só aparece com jogo em
 * andamento). Em andamento: agendado, já começou e começou há menos de 4 h. O placar e o minuto vêm do parcial da fonte,
 * quando ela traz o jogo; sem ele, o minuto sai do horário de início e o placar fica nulo.
 */
export function classifyGames(
  rows: readonly GameRow[],
  opts: { now: Date; dayStart: Date; nextDayStart: Date; prices: ReadonlyMap<string, PriceInfo>; partials: readonly LiveMatch[] },
): Omit<LiveGames, "next"> {
  const now = opts.now.getTime();
  const side = (c: GameRow["home"]) => {
    const p = c.ticker ? opts.prices.get(c.ticker) : undefined;
    return { ticker: c.ticker, name: c.name, price: p?.price ?? null, changeBp: p?.changeBp ?? null };
  };
  const base = (r: GameRow) => ({
    competition: r.competition as LiveGame["competition"],
    round: r.round,
    phase: r.phase,
    kickoff: r.kickoff.toISOString(),
    home: side(r.home),
    away: side(r.away),
  });
  const live: LiveGame[] = [];
  const upcoming: LiveGame[] = [];
  const finished: LiveGame[] = [];
  for (const r of [...rows].sort((a, b) => a.kickoff.getTime() - b.kickoff.getTime())) {
    if (!(FIXTURE_COMPETITIONS as readonly string[]).includes(r.competition)) continue;
    const at = r.kickoff.getTime();
    if (r.status === "finished") {
      if (at >= opts.dayStart.getTime() && at < opts.nextDayStart.getTime() && r.homeGoals !== null && r.awayGoals !== null) {
        finished.unshift({ ...base(r), minute: null, score: { home: r.homeGoals, away: r.awayGoals } });
      }
    } else if (r.status === "scheduled") {
      if (at > now) {
        if (at < opts.nextDayStart.getTime()) upcoming.push({ ...base(r), minute: null, score: null });
      } else if (now - at < LIVE_WINDOW_MS) {
        const p = r.home.ticker && r.away.ticker ? opts.partials.find((m) => m.home === r.home.ticker && m.away === r.away.ticker) : undefined;
        live.push({
          ...base(r),
          minute: p ? Math.round(p.minute) : Math.round(gameMinute(now - at)),
          score: p ? { home: p.homeGoals, away: p.awayGoals } : null,
        });
      }
    }
  }
  return { live, upcoming, finished };
}
