import type { CompetitionCode } from "@futbolsa/contracts";
import type { DateRange, ResultSource, SourceMatch, SourceStanding, SourceStatus } from "./types.js";

/** A API pública da football-data.org (plano grátis: 10 requisições por minuto). */
const BASE_URL = "https://api.football-data.org/v4";

/**
 * Códigos que a football-data.org usa. O plano em uso decide o que ela entrega: em 2026-11-08 a
 * chave do projeto recebeu 403 até na Série A (a lista de competições lista, mas os jogos ficam
 * restritos), então a configuração padrão usa a ESPN e esta fonte espera um plano que cubra.
 */
const CODES: Partial<Record<CompetitionCode, string>> = {
  "brasileirao-a": "BSA",
  "brasileirao-b": "BSB",
  libertadores: "CLI",
};

interface FdMatch {
  id: number;
  utcDate: string;
  status: string;
  matchday?: number | null;
  homeTeam: { name: string };
  awayTeam: { name: string };
  score: {
    winner?: "HOME_TEAM" | "AWAY_TEAM" | "DRAW" | null;
    duration?: string;
    fullTime: { home: number | null; away: number | null };
  };
}

/** `FINISHED` e `AWARDED` valem como encerrado; o que a fonte ainda não jogou segue agendado. */
function statusOf(s: string): SourceStatus {
  if (s === "FINISHED" || s === "AWARDED") return "finished";
  if (s === "CANCELLED") return "cancelled";
  if (s === "POSTPONED" || s === "SUSPENDED") return "postponed";
  return "scheduled";
}

/** A resposta de `/competitions/<código>/matches` para jogos do jogo. Pura: sem rede nem banco. */
export function convertFootballDataMatches(body: { matches: FdMatch[] }, competition: CompetitionCode): SourceMatch[] {
  const isLeague = competition === "brasileirao-a" || competition === "brasileirao-b";
  return body.matches.map((m) => {
    const status = statusOf(m.status);
    const finished = status === "finished";
    const penalties = m.score.duration === "PENALTY_SHOOTOUT";
    const winner = m.score.winner === "HOME_TEAM" ? m.homeTeam.name : m.score.winner === "AWAY_TEAM" ? m.awayTeam.name : null;
    return {
      source: "football-data",
      sourceId: String(m.id),
      competition,
      round: isLeague ? (m.matchday ?? null) : null,
      phase: null,
      kickoff: new Date(m.utcDate),
      status,
      homeName: m.homeTeam.name,
      awayName: m.awayTeam.name,
      homeGoals: finished ? m.score.fullTime.home : null,
      awayGoals: finished ? m.score.fullTime.away : null,
      advancedName: finished && penalties ? winner : null,
    };
  });
}

/** A resposta de `/competitions/<código>/standings`: o quadro `TOTAL`. */
export function convertFootballDataStandings(body: {
  standings: Array<{ type: string; table: Array<{ position: number; team: { name: string }; points: number }> }>;
}): SourceStanding[] {
  const total = body.standings.find((s) => s.type === "TOTAL") ?? body.standings[0];
  return (total?.table ?? []).map((r) => ({ clubName: r.team.name, position: r.position, points: r.points }));
}

export interface FootballDataOptions {
  /** `FOOTBALL_DATA_KEY`; nunca vai para o git nem para o registro. */
  key: string;
  fetchFn?: typeof fetch;
}

export class FootballDataSource implements ResultSource {
  readonly id = "football-data";
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: FootballDataOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async fetchMatches(competition: CompetitionCode, year: number, range?: DateRange): Promise<SourceMatch[]> {
    const code = this.codeOf(competition);
    const dates = range ? `&dateFrom=${day(range.from)}&dateTo=${day(range.to)}` : "";
    const body = await this.get<{ matches: FdMatch[] }>(`/competitions/${code}/matches?season=${year}${dates}`);
    return convertFootballDataMatches(body, competition);
  }

  async fetchStandings(competition: CompetitionCode, year: number): Promise<SourceStanding[]> {
    const code = this.codeOf(competition);
    return convertFootballDataStandings(await this.get(`/competitions/${code}/standings?season=${year}`));
  }

  private codeOf(competition: CompetitionCode): string {
    const code = CODES[competition];
    if (!code) throw new Error(`A football-data.org não cobre ${competition} no plano em uso.`);
    return code;
  }

  private async get<T>(path: string): Promise<T> {
    const response = await this.fetchFn(`${BASE_URL}${path}`, { headers: { "X-Auth-Token": this.options.key } });
    if (!response.ok) throw new Error(`football-data.org respondeu ${response.status}`);
    return (await response.json()) as T;
  }
}

const day = (d: Date) => d.toISOString().slice(0, 10);
