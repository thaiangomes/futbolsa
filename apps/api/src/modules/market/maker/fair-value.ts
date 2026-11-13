import {
  cupExpected,
  eventsFor,
  fairValue,
  prepareCups,
  projectLeague,
  type Cents,
  LeagueView,
  type LeagueProjection,
  type Match,
  type SeasonValues,
} from "@futbolsa/engine";

/**
 * O valor justo que a casa calcula para cada clube (Livro de ofertas, "Cotação do formador de mercado › Âncora"),
 * montado das mesmas peças que a simulação usa, mas com o que o banco sabe: os jogos, a classificação oficial
 * importada e os valores da temporada. A conta é a do motor (`fairValue`); aqui só se reúne a entrada.
 *
 * "Fechado" é o que `eventsFor` dá como fechado até o instante: o valor justo cai no fechamento da rodada ou da
 * fase, não na aprovação do admin (critério 28). Função pura: o instante e a foto dos jogos vêm de quem chama.
 */

export interface FairValueData {
  /** Todos os jogos da temporada, no formato do motor (o clube é o ticker, ou `EXT-<id>` se não listado). */
  matches: readonly Match[];
  /** Classificação oficial importada por competição (`brasileirao-a`, `brasileirao-b`); ausente enquanto não importada. */
  officialStandings: Readonly<Record<string, readonly string[]>>;
  values: SeasonValues;
  /** Os clubes listados e a divisão de cada um. */
  listed: ReadonlyMap<string, "A" | "B">;
  /** A recompra em múltiplos dos dividendos da temporada (1,5 = 15.000 pontos-base). */
  buybackMultiple: number;
}

const LEAGUE_OF = { A: "brasileirao-a", B: "brasileirao-b" } as const;
const CUPS = ["copa-do-brasil", "libertadores", "sulamericana"] as const;

export function fairValuesAt(data: FairValueData, now: number): Map<string, Cents> {
  const { matches, values } = data;

  // Copa com jogos mas sem a tabela de fases e valores confirmada: não há como esperar dividendo dela.
  for (const cup of CUPS) {
    const hasMatches = matches.some((m) => m.competition === cup && m.phase !== undefined);
    if (hasMatches && (values.cups[cup] === undefined || values.cups[cup]!.phases.length === 0)) {
      throw new Error(`tabela da copa ${cup} não confirmada: sem ela o valor justo não conta os dividendos da copa`);
    }
  }

  const { events, closes } = eventsFor({
    matches,
    standings: data.officialStandings,
    values,
    listed: new Set(data.listed.keys()),
  });
  const closed = events.filter((e) => e.closedAt <= now);

  const cups = prepareCups(
    CUPS.filter((c) => values.cups[c] !== undefined && matches.some((m) => m.competition === c && m.phase !== undefined)).map((c) => ({
      rules: values.cups[c]!,
      matches: matches.filter((m) => m.competition === c && m.phase !== undefined),
    })),
  );

  const projections = new Map<string, LeagueProjection>();
  const projectionOf = (competition: string): LeagueProjection => {
    let projection = projections.get(competition);
    if (!projection) {
      const leagueMatches = matches.filter((m) => m.competition === competition && m.status !== "cancelled");
      if (leagueMatches.length === 0) throw new Error(`sem jogos de ${competition}: o valor justo precisa do calendário importado`);
      const clubs = new Set<string>();
      for (const m of leagueMatches) {
        clubs.add(m.home);
        clubs.add(m.away);
      }
      const gamesPerClub = (2 * leagueMatches.length) / clubs.size;
      projection = projectLeague(leagueMatches.filter((m) => m.status === "finished"), [...clubs], gamesPerClub);
      projections.set(competition, projection);
    }
    return projection;
  };

  const result = new Map<string, Cents>();
  for (const [ticker, division] of data.listed) {
    const competition = LEAGUE_OF[division];
    const rules = values.leagues[competition];
    if (!rules) throw new Error(`sem valores de ${competition} na temporada`);
    const mine = closed.filter((e) => e.clubId === ticker);
    const closedPointsValue = mine.filter((e) => e.kind === "points" && e.competition === competition).reduce((sum, e) => sum + e.perShare, 0);
    const closedAt = closes[competition];
    result.set(
      ticker,
      fairValue({
        projection: projectionOf(competition),
        clubId: ticker,
        rules,
        buybackMultiple: data.buybackMultiple,
        // o evento guarda o dividendo (pontos × valor do ponto): volta a pontos
        closedPoints: rules.perPoint > 0 ? Math.round(closedPointsValue / rules.perPoint) : 0,
        placementClosed: closedAt !== undefined && closedAt <= now && data.officialStandings[competition] !== undefined,
        cupClosed: mine.filter((e) => e.kind === "cup_phase" || e.kind === "cup_title").reduce((sum, e) => sum + e.perShare, 0),
        cupExpected: cupExpected(ticker, now, cups),
      }),
    );
  }
  return result;
}

/**
 * As visões do campeonato para os bots ao vivo (F14, T11): uma `LeagueView` por divisão, do mesmo motor que a simulação
 * usa, montada da mesma foto do banco que o valor justo da casa (`fairValuesAt`) usa. O que está "pago" é o que o motor
 * dá como fechado até o instante. Devolve a visão de cada clube listado (por ticker).
 */
export function leagueViewsAt(data: FairValueData, now: number): Map<string, LeagueView> {
  const { matches, values } = data;
  const { events, closes } = eventsFor({ matches, standings: data.officialStandings, values, listed: new Set(data.listed.keys()) });
  const closed = events.filter((e) => e.closedAt <= now);
  const cupMatches = CUPS.filter((c) => values.cups[c] !== undefined && matches.some((m) => m.competition === c && m.phase !== undefined)).map((c) => ({
    rules: values.cups[c]!,
    matches: matches.filter((m) => m.competition === c && m.phase !== undefined),
  }));

  const out = new Map<string, LeagueView>();
  for (const division of ["A", "B"] as const) {
    const competition = LEAGUE_OF[division];
    const rules = values.leagues[competition];
    const listed = [...data.listed].filter(([, d]) => d === division).map(([ticker]) => ticker);
    if (!rules || listed.length === 0) continue;
    const leagueMatches = matches.filter((m) => m.competition === competition && m.status !== "cancelled");
    if (leagueMatches.length === 0) continue;
    const clubs = new Set<string>();
    for (const m of leagueMatches) {
      clubs.add(m.home);
      clubs.add(m.away);
    }
    const view = new LeagueView([...clubs], rules, leagueMatches);
    view.now = now;
    view.buybackMultiple = data.buybackMultiple;
    view.setCups(cupMatches);
    view.setKnownMatches(leagueMatches.filter((m) => m.status === "finished"));
    const closedAt = closes[competition];
    view.placementPaid = closedAt !== undefined && closedAt <= now && data.officialStandings[competition] !== undefined;
    // todo clube do campeonato tem a visão (o adversário não listado entra na estimativa dos bots)
    for (const club of clubs) if (!out.has(club)) out.set(club, view);
    for (const ticker of listed) {
      const mine = closed.filter((e) => e.clubId === ticker);
      const points = mine.filter((e) => e.kind === "points" && e.competition === competition).reduce((sum, e) => sum + e.perShare, 0);
      view.paidPoints.set(ticker, rules.perPoint > 0 ? Math.round(points / rules.perPoint) : 0);
      view.cupPaid.set(ticker, mine.filter((e) => e.kind === "cup_phase" || e.kind === "cup_title").reduce((sum, e) => sum + e.perShare, 0));
      out.set(ticker, view);
    }
  }
  return out;
}
