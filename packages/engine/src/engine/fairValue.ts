import { computeStandings, placementWithQualification, type CupRules, type LeagueRules, type StandingRow } from "./dividends.js";
import type { Cents } from "./money.js";
import { finishTime, kickoffTime, type Match } from "./types.js";

/**
 * Valor justo de uma ação, a âncora do formador de mercado (especificação
 * "Livro de ofertas e formador de mercado"): dividendos que ainda não fecharam
 * (pontos ganhos, pontos esperados nos jogos que faltam, colocação final
 * projetada, copas esperadas) mais a recompra esperada. Os valores e o múltiplo
 * entram como parâmetro (no jogo, vêm do módulo `dividends`).
 *
 * Conta o que ainda não fechou, e não o que ainda não foi pago: quem recebe é
 * quem tinha a ação no fechamento, então o valor justo cai no fechamento, antes
 * da aprovação do admin. Na simulação os dois são o mesmo instante.
 */

/** Uma copa pronta para as contas: fases em ordem de início e o fim de cada uma. */
export interface PreparedCup {
  rules: CupRules;
  /** Fases na ordem em que começam, inclusive as preliminares que não pagam. */
  phases: string[];
  byPhase: Map<string, Match[]>;
  /** Fim do último jogo de cada fase (Infinity se ainda falta jogo). */
  completeAt: Map<string, number>;
}

export function prepareCups(cups: ReadonlyArray<{ matches: readonly Match[]; rules: CupRules }>): PreparedCup[] {
  return cups.map(({ matches, rules }) => {
    const live = matches.filter((m) => m.status !== "cancelled");
    const phases = [...new Set([...live].sort((a, b) => kickoffTime(a) - kickoffTime(b)).map((m) => m.phase!))];
    const byPhase = new Map(phases.map((p) => [p, live.filter((m) => m.phase === p)]));
    const completeAt = new Map(
      phases.map((p) => {
        const list = byPhase.get(p)!;
        return [p, list.every((m) => m.status === "finished") ? Math.max(...list.map(finishTime)) : Infinity];
      }),
    );
    return { rules, phases, byPhase, completeAt };
  });
}

/**
 * Fase em que o clube está vivo na copa no instante `at`, só com o que já se
 * sabe: ele passa para a fase seguinte quando a atual termina e ele aparece
 * nela. -1 se não disputa, foi eliminado ou a copa acabou.
 */
export function cupStage(cup: PreparedCup, clubId: string, at: number): number {
  const plays = (p: string) => cup.byPhase.get(p)!.some((m) => m.home === clubId || m.away === clubId);
  let i = cup.phases.findIndex(plays);
  if (i < 0) return -1;
  while (at >= cup.completeAt.get(cup.phases[i]!)!) {
    // Pode pular uma fase (o primeiro do grupo da Sul-Americana não joga os playoffs).
    const next = cup.phases.findIndex((p, j) => j > i && plays(p));
    if (next < 0) return -1;
    i = next;
  }
  return i;
}

/**
 * Dividendos de copa que o clube ainda pode receber a partir de `at`, esperados
 * com metade de chance de passar de cada fase (inclusive as preliminares, que
 * não pagam). Usado no valor justo e no centro da faixa do IPO.
 */
export function cupExpected(clubId: string, at: number, cups: readonly PreparedCup[]): Cents {
  let total = 0;
  for (const cup of cups) {
    const stage = cupStage(cup, clubId, at);
    if (stage < 0) continue;
    const first = cup.phases.indexOf(cup.rules.phases[0]!);
    const ahead = cup.rules.phases;
    // Fase atual dentro das que pagam; nas preliminares, ainda falta passar por elas.
    const start = Math.max(0, ahead.indexOf(cup.phases[stage]!));
    const pre = stage < first ? first - stage : 0;
    let chance = 0.5 ** pre;
    for (let j = start; j < ahead.length - 1; j++) {
      chance *= 0.5;
      total += chance * (cup.rules.advance[ahead[j]!] ?? 0);
    }
    total += chance * 0.5 * cup.rules.title;
  }
  return Math.round(total);
}

/** Palpite de pontos por jogo antes de qualquer resultado, e o peso dele em jogos. */
export interface PointsPrior {
  ppg: number;
  weight: number;
}

export const DEFAULT_PRIOR: PointsPrior = { ppg: 1.35, weight: 5 };

/** Tabela com os jogos já encerrados e a colocação final projetada, calculadas uma vez por mudança de resultado. */
export interface LeagueProjection {
  clubIds: readonly string[];
  gamesPerClub: number;
  prior: PointsPrior;
  standings: Map<string, StandingRow>;
  projectedRank: Map<string, number>;
}

export function projectLeague(
  knownMatches: readonly Match[],
  clubIds: readonly string[],
  gamesPerClub: number,
  prior: PointsPrior = DEFAULT_PRIOR,
): LeagueProjection {
  const standings = new Map(computeStandings(knownMatches).map((r) => [r.clubId, r]));
  const projection: LeagueProjection = { clubIds, gamesPerClub, prior, standings, projectedRank: new Map() };
  const projected = clubIds.map((id) => {
    const row = standings.get(id);
    const remaining = Math.max(0, gamesPerClub - (row?.played ?? 0));
    return { id, final: (row?.points ?? 0) + pointsPerGame(projection, id) * remaining };
  });
  projected.sort((a, b) => b.final - a.final);
  projection.projectedRank = new Map(projected.map((p, i) => [p.id, i + 1]));
  return projection;
}

/** Pontos por jogo do clube, com o palpite inicial pesando como jogos já disputados. */
export function pointsPerGame(projection: LeagueProjection, clubId: string): number {
  const row = projection.standings.get(clubId);
  return ((row?.points ?? 0) + projection.prior.ppg * projection.prior.weight) / ((row?.played ?? 0) + projection.prior.weight);
}

/** O que já fechou para o clube e o que ainda se espera dele, além da tabela. */
export interface FairValueInput {
  projection: LeagueProjection;
  clubId: string;
  rules: LeagueRules;
  /** Recompra no fim da temporada, em múltiplos dos dividendos dela (0 = sem recompra). */
  buybackMultiple: number;
  /** Pontos cujo dividendo já fechou (rodadas fechadas). */
  closedPoints: number;
  /** Se a colocação final já fechou. */
  placementClosed: boolean;
  /** Dividendos de copa por ação que já fecharam. */
  cupClosed: Cents;
  /** Dividendos de copa esperados daqui para a frente (`cupExpected`). */
  cupExpected: Cents;
}

/**
 * Valor justo: pontos ganhos e ainda não fechados, mais os pontos esperados
 * nos jogos que faltam, vezes o dividendo por ponto, mais a colocação final
 * projetada (se ainda não fechou), mais as copas esperadas, mais a recompra
 * esperada (o múltiplo vezes os dividendos projetados da temporada inteira).
 */
export function fairValue(i: FairValueInput): Cents {
  const row = i.projection.standings.get(i.clubId);
  const played = row?.played ?? 0;
  const points = row?.points ?? 0;
  const remaining = Math.max(0, i.projection.gamesPerClub - played);
  const ppg = pointsPerGame(i.projection, i.clubId);
  const unclosed = points - i.closedPoints;
  const rank = i.projection.projectedRank.get(i.clubId)!;
  const projectedPlacement = placementWithQualification(i.rules, rank);
  const placement = i.placementClosed ? 0 : projectedPlacement - (i.rules.penalty?.[rank - 1] ?? 0);
  const seasonTotal = (points + ppg * remaining) * i.rules.perPoint + projectedPlacement + i.cupClosed + i.cupExpected;
  return Math.round((unclosed + ppg * remaining) * i.rules.perPoint + placement + i.cupExpected + i.buybackMultiple * seasonTotal);
}

/**
 * Valor justo com outra estimativa de pontos por jogo nos jogos que faltam (a
 * do bot analista), com a colocação projetada também por ela. No empate, o
 * clube fica com a melhor posição.
 */
export function fairValueWithPpg(i: FairValueInput, ppg: (clubId: string) => number): Cents {
  const { standings, gamesPerClub, clubIds } = i.projection;
  const final = (id: string) => {
    const row = standings.get(id);
    return (row?.points ?? 0) + ppg(id) * Math.max(0, gamesPerClub - (row?.played ?? 0));
  };
  const mine = final(i.clubId);
  const rank = 1 + clubIds.filter((id) => id !== i.clubId && final(id) > mine).length;
  const points = standings.get(i.clubId)?.points ?? 0;
  const unclosed = points - i.closedPoints;
  const projectedPlacement = placementWithQualification(i.rules, rank);
  const placement = i.placementClosed ? 0 : projectedPlacement - (i.rules.penalty?.[rank - 1] ?? 0);
  const rest = mine - points;
  const seasonTotal = mine * i.rules.perPoint + projectedPlacement + i.cupClosed + i.cupExpected;
  return Math.round((unclosed + rest) * i.rules.perPoint + placement + i.cupExpected + i.buybackMultiple * seasonTotal);
}
