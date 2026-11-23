import { finishTime, kickoffTime, type Match } from "./types.js";

/**
 * Jogos de copa e de campeonato sorteados com o que já se sabe (especificação "Vagas e copas no valor justo dos bots"): gols
 * restantes como Poisson, a partir do placar de agora e da fração do jogo que falta, com a força de cada lado. Serve só ao valor
 * justo dos bots; nada aqui paga dividendo nem decide classificação oficial.
 *
 * - Jogo único ou ida e volta (placar agregado, sem gol fora de casa); empate no agregado vai à prorrogação (um terço do ritmo
 *   de gols) e depois aos pênaltis (50%). Quando a fonte já traz o vencedor de um confronto terminado, vale ele.
 * - Fase de grupos: os jogos que faltam são sorteados e a tabela desempata por pontos, vitórias, saldo, gols pró e sorteio.
 */

/** Média de gols por jogo do Brasileirão (mandante e visitante), a mesma de `liveScore.ts`. */
export const HOME_GOALS = 1.45;
export const AWAY_GOALS = 1.15;
/** Quanto a diferença de força (em pontos por jogo) pesa nos gols esperados de cada lado. */
export const STRENGTH_WEIGHT = 0.3;
const DURATION = 90;

export interface RandomSource {
  next(): number;
}

/**
 * Sorteia uma contagem de gols com média `lambda` por inversão da distribuição: um número aleatório só por sorteio, e o resultado
 * cresce junto com a média. Assim, com a mesma semente, mudar o placar ou o minuto de um jogo só muda o que a mudança causa.
 */
export function samplePoisson(rng: RandomSource, lambda: number): number {
  const u = rng.next();
  if (lambda <= 0) return 0;
  let p = Math.exp(-lambda);
  let cumulative = p;
  let k = 0;
  while (u > cumulative && k < 30) {
    k++;
    p = (p * lambda) / k;
    cumulative += p;
  }
  return k;
}

/** Gols esperados do mandante e do visitante num jogo inteiro, pelas forças (pontos por jogo) dos dois. */
export function goalRates(homeStrength: number, awayStrength: number): { home: number; away: number } {
  const d = STRENGTH_WEIGHT * (homeStrength - awayStrength);
  return { home: HOME_GOALS * Math.exp(d), away: AWAY_GOALS * Math.exp(-d) };
}

/** O jogo em andamento no instante: o placar de agora e o minuto. */
export interface LivePosition {
  homeGoals: number;
  awayGoals: number;
  minute: number;
}

/** Placar final sorteado de um jogo ainda não terminado (a partir do placar de agora, se estiver em andamento). */
export function sampleScore(rng: RandomSource, home: string, away: string, strength: (id: string) => number, live?: LivePosition): { home: number; away: number } {
  const rates = goalRates(strength(home), strength(away));
  const left = live ? Math.max(0, (DURATION - live.minute) / DURATION) : 1;
  return {
    home: (live?.homeGoals ?? 0) + samplePoisson(rng, rates.home * left),
    away: (live?.awayGoals ?? 0) + samplePoisson(rng, rates.away * left),
  };
}

/** O jogo já acabou até `now`. */
export function isDone(m: Match, now: number): boolean {
  return m.status === "finished" && finishTime(m) <= now;
}

export type LiveLookup = (m: Match) => LivePosition | undefined;

/** O vencedor de um jogo decidido numa vez só, pelo placar. */
function byScore(m: Match): string | undefined {
  if (m.homeGoals === null || m.awayGoals === null || m.homeGoals === m.awayGoals) return undefined;
  return m.homeGoals > m.awayGoals ? m.home : m.away;
}

/**
 * Quem passa num confronto de um ou dois jogos (os jogos em ordem de início). Jogos terminados valem pelo placar real; os que
 * faltam são sorteados (o que está em andamento, a partir do placar de agora). Empate no agregado: prorrogação e pênaltis.
 * Devolve quem passou e quem perdeu.
 */
export function sampleTie(
  rng: RandomSource,
  legs: readonly Match[],
  now: number,
  strength: (id: string) => number,
  live: LiveLookup,
): { winner: string; loser: string } {
  const first = legs[0]!;
  const a = first.home;
  const b = first.away;
  let goalsA = 0;
  let goalsB = 0;
  let allDone = true;
  for (const leg of legs) {
    let home: number;
    let away: number;
    if (isDone(leg, now)) {
      rng.next(); // gasta os mesmos sorteios de um jogo por jogar, para os outros jogos do confronto não mudarem de sorteio
      rng.next();
      home = leg.homeGoals ?? 0;
      away = leg.awayGoals ?? 0;
    } else {
      allDone = false;
      const s = sampleScore(rng, leg.home, leg.away, strength, live(leg));
      home = s.home;
      away = s.away;
    }
    if (leg.home === a) {
      goalsA += home;
      goalsB += away;
    } else {
      goalsA += away;
      goalsB += home;
    }
  }
  const decider = legs[legs.length - 1]!;
  const rates = goalRates(strength(decider.home), strength(decider.away));
  const extraHome = samplePoisson(rng, rates.home / 3);
  const extraAway = samplePoisson(rng, rates.away / 3);
  const penalties = rng.next();
  if (goalsA !== goalsB) return goalsA > goalsB ? { winner: a, loser: b } : { winner: b, loser: a };
  if (allDone) {
    const known = decider.winner ?? (legs.length === 1 ? byScore(decider) : undefined); // na volta, o placar do jogo não decide o confronto
    if (known === a || known === b) return known === a ? { winner: a, loser: b } : { winner: b, loser: a };
  } else {
    const [extraA, extraB] = decider.home === a ? [extraHome, extraAway] : [extraAway, extraHome];
    if (extraA !== extraB) return extraA > extraB ? { winner: a, loser: b } : { winner: b, loser: a };
  }
  return penalties < 0.5 ? { winner: a, loser: b } : { winner: b, loser: a };
}

/** Os confrontos de uma fase de mata-mata: os jogos de cada par de clubes, em ordem de início. */
export function groupIntoTies(matches: readonly Match[]): Match[][] {
  const ties = new Map<string, Match[]>();
  for (const m of [...matches].sort((x, y) => kickoffTime(x) - kickoffTime(y))) {
    const key = [m.home, m.away].sort().join("|");
    const list = ties.get(key) ?? [];
    list.push(m);
    ties.set(key, list);
  }
  return [...ties.values()];
}

/** Os grupos de uma fase de grupos: os clubes ligados por jogos entre si. */
export function groupsOf(matches: readonly Match[]): Match[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const m of matches) {
    for (const c of [m.home, m.away]) if (!parent.has(c)) parent.set(c, c);
    parent.set(find(m.home), find(m.away));
  }
  const groups = new Map<string, Match[]>();
  for (const m of matches) {
    const root = find(m.home);
    const list = groups.get(root) ?? [];
    list.push(m);
    groups.set(root, list);
  }
  return [...groups.values()];
}

interface Row {
  club: string;
  points: number;
  wins: number;
  diff: number;
  goals: number;
  luck: number;
}

/** Tabela ordenada: pontos, vitórias, saldo, gols pró e, no que sobrar, sorteio. */
export function rankRows(rows: Row[]): string[] {
  return [...rows]
    .sort((x, y) => y.points - x.points || y.wins - x.wins || y.diff - x.diff || y.goals - x.goals || y.luck - x.luck)
    .map((r) => r.club);
}

/** A classificação final de um grupo, do 1º ao último, com os jogos que faltam sorteados. */
export function sampleGroup(rng: RandomSource, matches: readonly Match[], now: number, strength: (id: string) => number, live: LiveLookup): string[] {
  const rows = new Map<string, Row>();
  const row = (club: string) => {
    let r = rows.get(club);
    if (!r) {
      r = { club, points: 0, wins: 0, diff: 0, goals: 0, luck: rng.next() };
      rows.set(club, r);
    }
    return r;
  };
  for (const m of matches) {
    let home: number;
    let away: number;
    if (isDone(m, now)) {
      rng.next();
      rng.next();
      home = m.homeGoals ?? 0;
      away = m.awayGoals ?? 0;
    } else {
      const s = sampleScore(rng, m.home, m.away, strength, live(m));
      home = s.home;
      away = s.away;
    }
    const h = row(m.home);
    const a = row(m.away);
    h.goals += home;
    a.goals += away;
    h.diff += home - away;
    a.diff += away - home;
    if (home > away) {
      h.points += 3;
      h.wins++;
    } else if (home < away) {
      a.points += 3;
      a.wins++;
    } else {
      h.points++;
      a.points++;
    }
  }
  return rankRows([...rows.values()]);
}

/** Confronto de jogo único entre dois clubes ainda sem calendário (fases que o sorteio não definiu): o mando sai no sorteio. */
export function sampleNeutralTie(rng: RandomSource, a: string, b: string, strength: (id: string) => number): { winner: string; loser: string } {
  const [home, away] = rng.next() < 0.5 ? [a, b] : [b, a];
  const leg: Match = { id: `${home}-${away}`, competition: "", kickoff: "2999-01-01T00:00:00Z", home, away, homeGoals: null, awayGoals: null, status: "scheduled" };
  return sampleTie(rng, [leg], 0, strength, () => undefined);
}
