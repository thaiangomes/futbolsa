import {
  groupIntoTies,
  groupsOf,
  isDone,
  rankRows,
  sampleGroup,
  sampleNeutralTie,
  sampleScore,
  sampleTie,
  type LivePosition,
  type LiveLookup,
} from "./copas.js";
import type { LeagueRules } from "./dividends.js";
import type { PreparedCup } from "./fairValue.js";
import type { LiveMatch } from "./liveScore.js";
import type { Cents } from "./money.js";
import { kickoffTime, type Match } from "./types.js";
import { resolveSlots, type CupFinal, type SlotRules } from "./vagas.js";
import { Rng } from "../sim/rng.js";

/**
 * Valor justo dos bots por cenários (especificação "Vagas e copas no valor justo dos bots"): o resto da temporada é sorteado
 * várias vezes (jogos do campeonato, copas e rebaixamento), e em cada cenário a cascata das vagas diz quem vai à Libertadores
 * e à Sul-Americana. O valor de cada clube usa a média dos cenários. O resultado é determinístico para a mesma semente: o preço
 * só muda porque o mundo mudou, não por sorteio novo.
 */

export interface ScenarioInput {
  now: number;
  /** Os clubes do campeonato (Série A). */
  clubIds: readonly string[];
  rules: LeagueRules;
  /** Todos os jogos do campeonato, sem os cancelados. */
  leagueMatches: readonly Match[];
  cups: readonly PreparedCup[];
  /** Jogos em andamento com o placar de agora (campeonato e copas). */
  live: readonly LiveMatch[];
  /** Força do clube em pontos por jogo (quem não é do campeonato vale a média). */
  strength: (clubId: string) => number;
  slots: SlotRules;
  scenarios: number;
  seed: number;
}

/** O que o clube espera da temporada, em média sobre os cenários. */
export interface ClubScenario {
  /** Pontos finais no campeonato. */
  points: number;
  /** Colocação final mais o bônus de classificação, por ação. */
  placementQual: Cents;
  /** Penalização de rebaixamento, por ação (positiva). */
  penalty: Cents;
  /** Dividendos de copa que ainda não fecharam, por ação. */
  cupFuture: Cents;
  pLibertadores: number;
  pSulamericana: number;
  pRelegated: number;
}

export const DEFAULT_SCENARIOS = 500;

interface Row {
  club: string;
  points: number;
  wins: number;
  diff: number;
  goals: number;
  luck: number;
}

/** Gerador de cada coisa sorteada (um jogo, um confronto, um grupo) em cada cenário: só depende da semente, do cenário e do nome dela. */
const keyHashes = new Map<string, number>();
function keyHash(key: string): number {
  let h = keyHashes.get(key);
  if (h === undefined) {
    h = 2166136261;
    for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619) >>> 0;
    if (keyHashes.size > 20000) keyHashes.clear();
    keyHashes.set(key, h);
  }
  return h;
}
function streamOf(seed: number, scenario: number, key: string): Rng {
  return new Rng(Math.imul(keyHash(key) ^ seed, 0x85ebca6b) ^ Math.imul(scenario + 1, 0x9e3779b1));
}

const liveKey = (m: { home: string; away: string }) => `${m.home}|${m.away}`;

export function runScenarios(input: ScenarioInput): Map<string, ClubScenario> {
  const { now, clubIds, rules, leagueMatches, cups, strength, slots } = input;
  const livePositions = new Map<string, LivePosition>(
    input.live.map((l) => [liveKey(l), { homeGoals: l.homeGoals, awayGoals: l.awayGoals, minute: l.minute }]),
  );
  const live: LiveLookup = (m) => (isDone(m, now) || kickoffTime(m) > now ? undefined : livePositions.get(liveKey(m)));

  const done = leagueMatches.filter((m) => isDone(m, now));
  const pending = leagueMatches.filter((m) => !isDone(m, now));
  const base = new Map<string, Row>(clubIds.map((c) => [c, { club: c, points: 0, wins: 0, diff: 0, goals: 0, luck: 0 }]));
  const add = (rows: Map<string, Row>, m: Match, home: number, away: number) => {
    const h = rows.get(m.home);
    const a = rows.get(m.away);
    if (h) {
      h.goals += home;
      h.diff += home - away;
    }
    if (a) {
      a.goals += away;
      a.diff += away - home;
    }
    if (home === away) {
      if (h) h.points++;
      if (a) a.points++;
    } else if (home > away) {
      if (h) {
        h.points += 3;
        h.wins++;
      }
    } else if (a) {
      a.points += 3;
      a.wins++;
    }
  };
  for (const m of done) add(base, m, m.homeGoals ?? 0, m.awayGoals ?? 0);

  const sums = new Map<string, ClubScenario>(
    clubIds.map((c) => [c, { points: 0, placementQual: 0, penalty: 0, cupFuture: 0, pLibertadores: 0, pSulamericana: 0, pRelegated: 0 }]),
  );
  const listed = new Set(clubIds);
  const relegatedCount = rules.relegationSlots ?? (rules.penalty ?? []).filter((p) => p > 0).length;
  const qualification = rules.qualification;

  for (let s = 0; s < input.scenarios; s++) {
    // campeonato
    const rows = new Map<string, Row>([...base].map(([c, r]) => [c, { ...r, luck: streamOf(input.seed, s, `sorte|${c}`).next() }]));
    for (const m of pending) {
      const score = sampleScore(streamOf(input.seed, s, m.id), m.home, m.away, strength, live(m));
      add(rows, m, score.home, score.away);
    }
    const table = rankRows([...rows.values()]);
    const relegated = new Set<string>();
    table.forEach((club, i) => {
      if (i >= table.length - relegatedCount) relegated.add(club);
    });

    // copas
    const pay = new Map<string, number>(clubIds.map((c) => [c, 0]));
    const finals: Record<string, CupFinal> = {};
    for (const cup of cups) finals[cup.competition] = simulateCup(cup, (key) => streamOf(input.seed, s, `${cup.competition}|${key}`), now, strength, live, listed, pay);

    // vagas
    const vagas = resolveSlots(slots, table, relegated, finals);

    table.forEach((club, i) => {
      const sum = sums.get(club)!;
      const dest = vagas.get(club);
      sum.points += rows.get(club)!.points;
      sum.placementQual += (rules.placement[i] ?? 0) + (qualification && dest ? qualification[dest] : 0);
      sum.penalty += rules.penalty?.[i] ?? 0;
      sum.cupFuture += pay.get(club)!;
      if (dest === "libertadores") sum.pLibertadores++;
      if (dest === "sulamericana") sum.pSulamericana++;
      if (relegated.has(club)) sum.pRelegated++;
    });
  }

  const n = Math.max(1, input.scenarios);
  return new Map(
    [...sums].map(([club, v]) => [
      club,
      {
        points: v.points / n,
        placementQual: v.placementQual / n,
        penalty: v.penalty / n,
        cupFuture: v.cupFuture / n,
        pLibertadores: v.pLibertadores / n,
        pSulamericana: v.pSulamericana / n,
        pRelegated: v.pRelegated / n,
      },
    ]),
  );
}

const GROUPS = /grupo/i;

/** A estrutura de uma fase (confrontos ou grupos) não muda de um cenário para o outro: calculada uma vez por lista de jogos. */
const structures = new WeakMap<readonly Match[], Match[][]>();
function structureOf(list: readonly Match[], groups: boolean): Match[][] {
  let s = structures.get(list);
  if (!s) {
    s = groups ? groupsOf(list) : groupIntoTies(list);
    structures.set(list, s);
  }
  return s;
}

/**
 * Uma copa sorteada até o fim: os jogos que o calendário já tem (com o placar parcial dos que estão rolando) e, depois deles, as
 * fases que o sorteio ainda não definiu. Credita em `pay` o que cada clube do campeonato recebe das fases que ainda não
 * fecharam e devolve campeão e vice.
 *
 * - Quem sobrevive de uma fase para a seguinte vem do calendário quando ele já tem a fase seguinte; só a fase final do calendário
 *   alimenta as fases futuras.
 * - Fases futuras: a chave é completada até o tamanho esperado (2 elevado às fases que faltam) com adversários de força média,
 *   que também ocupam o lugar de quem ainda não está no calendário (entrada direta, 3º da Libertadores). Ninguém passa sem jogar.
 * - Fase de grupos que o calendário ainda não tem não é sorteada (os clubes dela são desconhecidos): fica fora da chave.
 */
function simulateCup(
  cup: PreparedCup,
  rngOf: (key: string) => Rng,
  now: number,
  strength: (id: string) => number,
  live: LiveLookup,
  listed: ReadonlySet<string>,
  pay: Map<string, number>,
): CupFinal {
  const { rules } = cup;
  const last = rules.phases.length - 1;
  const credit = (club: string | undefined, amount: number | undefined) => {
    if (club !== undefined && amount && listed.has(club)) pay.set(club, pay.get(club)! + amount);
  };
  let alive: string[] = [];
  /** Quem passou dos grupos para uma fase de repescagem (o 2º da Sul-Americana). */
  let repechage: string[] = [];
  /** Quem pulou a repescagem por regra (o 1º do grupo da Sul-Americana): só entra de novo na fase seguinte. */
  let direct: string[] = [];
  let lastIdx = -1;
  let final: CupFinal = {};

  for (const phase of cup.phases) {
    const list = cup.byPhase.get(phase)!;
    const idx = rules.phases.indexOf(phase);
    const open = list.some((m) => !isDone(m, now));
    if (idx >= 0) lastIdx = idx;
    const pays = open && idx >= 0;

    if (GROUPS.test(phase)) {
      const repechageTo = rules.advanceTo?.[phase];
      alive = [];
      repechage = [];
      direct = [];
      for (const group of structureOf(list, true)) {
        const [first, second] = sampleGroup(rngOf(`grupo|${group[0]!.id}`), group, now, strength, live);
        if (first === undefined) continue;
        alive.push(first);
        if (pays) credit(first, rules.advance[phase]);
        if (repechageTo) direct.push(first);
        if (second === undefined) continue;
        if (repechageTo) {
          repechage.push(second);
          if (pays) credit(second, Object.values(repechageTo)[0]);
        } else {
          alive.push(second);
          if (pays) credit(second, rules.advance[phase]);
        }
      }
      continue;
    }

    const playing = new Set(list.flatMap((m) => [m.home, m.away]));
    const carry = direct.filter((c) => !playing.has(c));
    direct = [];
    const winners: string[] = [];
    const losers: string[] = [];
    for (const tie of structureOf(list, false)) {
      const result = sampleTie(rngOf(`jogo|${tie[0]!.id}`), tie, now, strength, live);
      winners.push(result.winner);
      losers.push(result.loser);
      if (pays) credit(result.winner, idx === last ? rules.title : rules.advance[phase]);
    }
    alive = [...winners, ...carry];
    repechage = [];
    if (idx === last) final = { champion: winners[0], runnerUp: losers[0] };
  }

  // fases que o calendário ainda não tem
  let filler = 0;
  const average = () => `~media${filler++}`;
  for (let q = lastIdx + 1; q <= last; q++) {
    const name = rules.phases[q]!;
    if (GROUPS.test(name)) continue;
    const previous = rules.phases[q - 1];
    const isRepechage = previous !== undefined && rules.advanceTo?.[previous]?.[name] !== undefined;
    if (isRepechage) {
      // cada clube da repescagem enfrenta um adversário médio (o 3º da Libertadores, que o calendário ainda não traz)
      for (const club of repechage) {
        const result = sampleNeutralTie(rngOf(`repescagem|${q}|${club}`), club, average(), strength);
        if (result.winner === club) {
          alive.push(club);
          credit(club, rules.advance[name]);
        }
      }
      repechage = [];
      continue;
    }
    // chave cheia: 2 elevado às fases de mata-mata que faltam, com adversários médios no lugar de quem não está no calendário
    const remaining = rules.phases.slice(q).filter((p) => !GROUPS.test(p)).length;
    const size = 2 ** remaining;
    const pool = [...alive];
    while (pool.length < size) pool.push(average());
    const order = rngOf(`sorteio|${q}`).shuffle(pool.sort());
    const winners: string[] = [];
    const losers: string[] = [];
    for (let i = 0; i + 1 < order.length; i += 2) {
      const result = sampleNeutralTie(rngOf(`jogo|${q}|${order[i]}|${order[i + 1]}`), order[i]!, order[i + 1]!, strength);
      winners.push(result.winner);
      losers.push(result.loser);
      credit(result.winner, q === last ? rules.title : rules.advance[name]);
    }
    alive = winners;
    if (q === last) final = { champion: winners[0], runnerUp: losers[0] };
  }
  return final;
}
