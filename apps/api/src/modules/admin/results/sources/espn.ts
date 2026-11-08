import type { CompetitionCode } from "@futbolsa/contracts";
import type { DateRange, ResultSource, SourceMatch, SourceStanding, SourceStatus } from "./types.js";

/**
 * A API pública da ESPN: sem chave, sem documentação nem termos publicados (decisão do Thaian em
 * 2026-10-30 de usá-la mesmo assim; o admin corrige o que faltar). Achados da T4, conferidos com
 * chamadas reais em 2026-11-08:
 * - `dates=AAAA&limit=1000` devolve o ano inteiro numa chamada (380 jogos da Série B); `dates=A-B`
 *   com intervalo responde 400, então um período vira um dia por chamada;
 * - o placar do dia não traz a rodada dos pontos corridos: ela é derivada (`deriveRounds`);
 * - o estado do jogo vem em `competitions[0].status.type.name`.
 */
const LEAGUES: Record<CompetitionCode, string> = {
  "brasileirao-a": "bra.1",
  "brasileirao-b": "bra.2",
  "copa-do-brasil": "bra.copa_do_brazil",
  libertadores: "conmebol.libertadores",
  sulamericana: "conmebol.sudamericana",
};

const SITE = "https://site.api.espn.com/apis";

/**
 * Fases da ESPN para os nomes que o motor usa (`COPA_DO_BRASIL.phases` e as outras). A Copa do Brasil
 * de 2026 tem nove fases (`fourth-round`, `fifth-round`) e a final em jogo único (`final`); a de
 * 2025 tinha `finals`. As pré-fases de Libertadores e Sul-Americana não pagam, mas seguram nada.
 */
const PHASES: Record<string, string> = {
  "first-round": "1a-fase",
  "second-round": "2a-fase",
  "third-round": "3a-fase",
  "fourth-round": "4a-fase",
  "fifth-round": "5a-fase",
  "first-stage": "pre-1",
  "second-stage": "pre-2",
  "third-stage": "pre-3",
  "group-stage": "grupos",
  "knockout-round-playoffs": "playoffs",
  "round-of-16": "oitavas",
  quarterfinals: "quartas",
  semifinals: "semifinal",
  final: "final",
  finals: "final",
};

interface EspnCompetitor {
  homeAway: "home" | "away";
  score?: string;
  winner?: boolean;
  team: { displayName: string };
}
interface EspnEvent {
  id: string;
  date: string;
  season: { slug: string };
  competitions: Array<{ status: { type: { name: string } }; competitors: EspnCompetitor[] }>;
}

function statusOf(name: string): SourceStatus {
  if (/^STATUS_(FULL_TIME|FINAL)/.test(name)) return "finished";
  if (name === "STATUS_CANCELED") return "cancelled";
  // Adiado ou abandonado: o jogo não vale e será refeito.
  if (name === "STATUS_POSTPONED" || name === "STATUS_ABANDONED") return "postponed";
  return "scheduled";
}

/**
 * A rodada de cada jogo dos pontos corridos, já que a ESPN não a informa. Pela ordem dos horários, a
 * rodada de um jogo é a maior contagem de jogos já feitos pelos dois clubes, mais um: um adiado que
 * só é jogado depois não desloca os outros jogos do clube, porque o adversário em dia segura a conta.
 * Pode errar a rodada do próprio jogo adiado; o admin corrige (ele não segura a rodada de ninguém).
 */
export function deriveRounds(
  games: ReadonlyArray<{ id: string; home: string; away: string; kickoff: Date }>,
): Map<string, number> {
  const played = new Map<string, number>();
  const rounds = new Map<string, number>();
  const ordered = [...games].sort((a, b) => a.kickoff.getTime() - b.kickoff.getTime() || a.id.localeCompare(b.id));
  for (const g of ordered) {
    const home = played.get(g.home) ?? 0;
    const away = played.get(g.away) ?? 0;
    rounds.set(g.id, Math.max(home, away) + 1);
    played.set(g.home, home + 1);
    played.set(g.away, away + 1);
  }
  return rounds;
}

/** A resposta do placar da ESPN para jogos do jogo. Pura: sem rede nem banco. */
export function convertEspnEvents(body: { events?: EspnEvent[] }, competition: CompetitionCode): SourceMatch[] {
  const isLeague = competition === "brasileirao-a" || competition === "brasileirao-b";
  const seen = new Set<string>();
  const matches: SourceMatch[] = [];
  for (const event of body.events ?? []) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    const c = event.competitions[0]!;
    const homeC = c.competitors.find((x) => x.homeAway === "home")!;
    const awayC = c.competitors.find((x) => x.homeAway === "away")!;
    const statusName = c.status.type.name;
    const status = statusOf(statusName);
    const finished = status === "finished";
    // Fase desconhecida não derruba a importação: os formatos das copas mudam de um ano para o outro.
    const slug = event.season.slug.toLowerCase();
    const phase = isLeague ? null : (PHASES[slug] ?? slug);
    const winner = homeC.winner ? homeC.team.displayName : awayC.winner ? awayC.team.displayName : null;
    matches.push({
      source: "espn",
      sourceId: event.id,
      competition,
      round: null,
      phase,
      kickoff: new Date(event.date),
      status,
      homeName: homeC.team.displayName,
      awayName: awayC.team.displayName,
      homeGoals: finished ? Number(homeC.score) : null,
      awayGoals: finished ? Number(awayC.score) : null,
      advancedName: finished && !isLeague && (statusName === "STATUS_FINAL_PEN" || phase === "final") ? winner : null,
    });
  }
  if (isLeague) {
    const rounds = deriveRounds(
      matches.map((m) => ({ id: m.sourceId, home: m.homeName, away: m.awayName, kickoff: m.kickoff })),
    );
    for (const m of matches) m.round = rounds.get(m.sourceId) ?? null;
  }
  return matches;
}

interface EspnStandingsBody {
  children?: Array<{
    standings?: { entries?: Array<{ team: { displayName: string }; stats: Array<{ name: string; value: number }> }> };
  }>;
}

/** A classificação da ESPN: posição (`rank`) e pontos de cada clube, em ordem. */
export function convertEspnStandings(body: EspnStandingsBody): SourceStanding[] {
  const entries = body.children?.[0]?.standings?.entries ?? [];
  return entries
    .map((e) => ({
      clubName: e.team.displayName,
      position: e.stats.find((s) => s.name === "rank")?.value ?? 0,
      points: e.stats.find((s) => s.name === "points")?.value ?? 0,
    }))
    .sort((a, b) => a.position - b.position);
}

export interface EspnOptions {
  fetchFn?: typeof fetch;
}

export class EspnSource implements ResultSource {
  readonly id = "espn";
  private readonly fetchFn: typeof fetch;

  constructor(options: EspnOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async fetchMatches(competition: CompetitionCode, year: number, range?: DateRange): Promise<SourceMatch[]> {
    const league = LEAGUES[competition];
    const dates = range ? daysBetween(range) : [String(year)];
    const events: EspnEvent[] = [];
    // Cinco chamadas por vez: a API não publica limite, e é só uma conferência dos dias pedidos.
    for (let i = 0; i < dates.length; i += 5) {
      const batch = await Promise.all(
        dates.slice(i, i + 5).map((d) => this.get<{ events?: EspnEvent[] }>(`${SITE}/site/v2/sports/soccer/${league}/scoreboard?dates=${d}&limit=1000`)),
      );
      for (const body of batch) events.push(...(body.events ?? []));
    }
    return convertEspnEvents({ events }, competition);
  }

  async fetchStandings(competition: CompetitionCode, year: number): Promise<SourceStanding[]> {
    const league = LEAGUES[competition];
    return convertEspnStandings(await this.get<EspnStandingsBody>(`${SITE}/v2/sports/soccer/${league}/standings?season=${year}`));
  }

  private async get<T>(url: string): Promise<T> {
    const response = await this.fetchFn(url);
    if (!response.ok) throw new Error(`ESPN respondeu ${response.status}`);
    return (await response.json()) as T;
  }
}

/** Os dias do intervalo, inclusive, como `AAAAMMDD` em UTC. */
function daysBetween(range: DateRange): string[] {
  const days: string[] = [];
  const end = Date.UTC(range.to.getUTCFullYear(), range.to.getUTCMonth(), range.to.getUTCDate());
  for (
    let t = Date.UTC(range.from.getUTCFullYear(), range.from.getUTCMonth(), range.from.getUTCDate());
    t <= end;
    t += 86_400_000
  ) {
    days.push(new Date(t).toISOString().slice(0, 10).replaceAll("-", ""));
  }
  return days;
}
