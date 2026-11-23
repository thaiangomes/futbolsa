import type { Ledger } from "./ledger.js";
import type { Cents } from "./money.js";
import { finishTime, type Match } from "./types.js";

/**
 * Dividendos: funções puras que, a partir das partidas, dizem quanto cada ação
 * recebe e em que momento. Recebe quem tiver a ação nesse momento.
 *
 * Brasileirão (pontos corridos)
 * - R$ 0,10 por ponto por ação (Série B: metade), pagos no fechamento da rodada,
 *   ou seja, logo depois do último jogo da rodada.
 * - Jogo adiado (ou antecipado) não segura a rodada: os pontos dele pagam no
 *   fechamento da primeira rodada que terminar depois que ele for disputado.
 * - Título e colocação final: no fechamento da última rodada, com a tabela
 *   inteira definida.
 *
 * Copas
 * - Fase avançada: quando terminam todos os jogos daquela fase.
 * - Título: no apito final da decisão.
 *
 * Recompra (opcional, para calibração)
 * - Logo depois do último dividendo da temporada, a casa recompra todas as
 *   ações de cada clube por um múltiplo do total que a ação pagou de dividendos
 *   na temporada, somando todas as competições. As ações deixam de existir.
 */

export type PayoutKind = "points" | "placement" | "qualification" | "cup-phase" | "cup-title" | "buyback" | "penalty";

export interface Payout {
  /** Momento do pagamento (ms desde 1970). */
  at: number;
  clubId: string;
  /** Valor por ação, em centavos. */
  perShare: Cents;
  kind: PayoutKind;
  competition: string;
  detail: string;
}

export interface LeagueRules {
  perPoint: Cents;
  /** Dividendo por colocação final; índice 0 = 1º lugar. Faltando = zero. */
  placement: Cents[];
  /**
   * Classificação para o ano seguinte (decisão de 2026-11-20): bônus por ação de quem vai à Libertadores e à
   * Sul-Americana (quem vai às duas recebe só o da Libertadores). No jogo o admin marca os classificados no
   * fechamento; antes disso (valor justo, simulação) vale a projeção de `QUALIFICATION_SLOTS` pela colocação.
   * Faltando = sem bônus.
   */
  qualification?: { libertadores: Cents; sulamericana: Cents };
  /**
   * Rebaixamento: quanto cada ação paga, no fechamento, por terminar em cada colocação (índice 0 = 1º),
   * debitado do caixa de quem tem a ação, mesmo que fique negativo. Fica fora da base da recompra. Faltando = zero.
   */
  penalty?: Cents[];
  /** Quantos clubes caem (os últimos da tabela). Faltando, vale o número de colocações com penalização. */
  relegationSlots?: number;
}

/** Vagas que a projeção usa para o bônus de classificação: Libertadores do 1º ao 6º, Sul-Americana do 7º ao 12º. */
export const QUALIFICATION_SLOTS = { libertadores: 6, sulamericana: 6 } as const;

/** Bônus de classificação projetado para a colocação `rank` (1 = campeão): o da Libertadores, o da Sul-Americana ou zero. */
export function projectedQualification(rules: LeagueRules, rank: number): Cents {
  const q = rules.qualification;
  if (!q) return 0;
  if (rank >= 1 && rank <= QUALIFICATION_SLOTS.libertadores) return q.libertadores;
  if (rank > QUALIFICATION_SLOTS.libertadores && rank <= QUALIFICATION_SLOTS.libertadores + QUALIFICATION_SLOTS.sulamericana) return q.sulamericana;
  return 0;
}

/** O que a colocação `rank` rende por ação: a tabela mais o bônus projetado de classificação (sem a penalização). */
export function placementWithQualification(rules: LeagueRules, rank: number): Cents {
  return (rules.placement[rank - 1] ?? 0) + projectedQualification(rules, rank);
}

/** Colocação da Série A até 2026-11-20 (R$ 5,00 do 1º a R$ 0,20 do 16º): a base de que o preço sugerido do IPO partiu. */
export const PLACEMENT_BASELINE: readonly Cents[] = [500, 450, 400, 350, 300, 270, 240, 210, 180, 150, 120, 100, 80, 60, 40, 20];

/** As regras da liga com todos os valores multiplicados por `scale` (os experimentos da simulação mexem na escala do dividendo). */
export function scaleLeagueRules(rules: LeagueRules, scale: number): LeagueRules {
  const k = (v: Cents) => Math.round(v * scale);
  return {
    perPoint: k(rules.perPoint),
    placement: rules.placement.map(k),
    ...(rules.qualification ? { qualification: { libertadores: k(rules.qualification.libertadores), sulamericana: k(rules.qualification.sulamericana) } } : {}),
    ...(rules.penalty ? { penalty: rules.penalty.map(k) } : {}),
    ...(rules.relegationSlots !== undefined ? { relegationSlots: rules.relegationSlots } : {}),
  };
}

/** Série A até 2026-11-20 (R$ 5,00 a R$ 0,20, sem bônus de classificação nem penalização): fica para os testes de regressão e a temporada de 2026. */
export const BRASILEIRAO_A_2026: LeagueRules = { perPoint: 10, placement: [...PLACEMENT_BASELINE] };

/**
 * Série A (decisão do Thaian em 2026-11-20, depois da rodada F2): R$ 0,10 por ponto; colocação de R$ 10,00 (1º) a R$ 0,30 (16º);
 * R$ 3,00 de Libertadores e R$ 1,00 de Sul-Americana; −R$ 1,00 por ação para os quatro rebaixados.
 */
export const BRASILEIRAO_A: LeagueRules = {
  perPoint: 10,
  placement: [1000, 700, 500, 450, 400, 350, 300, 270, 240, 210, 180, 150, 120, 90, 60, 30],
  qualification: { libertadores: 300, sulamericana: 100 },
  penalty: [...Array<number>(16).fill(0), 100, 100, 100, 100],
  relegationSlots: 4,
};

/** Série B: metade por ponto; bônus de R$ 2,00 para os quatro que sobem. */
export const BRASILEIRAO_B: LeagueRules = {
  perPoint: 5,
  placement: [200, 200, 200, 200],
};

export interface StandingRow {
  clubId: string;
  played: number;
  points: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
}

export function matchPoints(m: Match): { home: number; away: number } | undefined {
  if (m.status !== "finished" || m.homeGoals === null || m.awayGoals === null) return undefined;
  if (m.homeGoals > m.awayGoals) return { home: 3, away: 0 };
  if (m.homeGoals < m.awayGoals) return { home: 0, away: 3 };
  return { home: 1, away: 1 };
}

/** Tabela com os critérios de desempate da CBF: pontos, vitórias, saldo, gols pró. */
export function computeStandings(matches: readonly Match[]): StandingRow[] {
  const rows = new Map<string, StandingRow>();
  const row = (clubId: string) => {
    let r = rows.get(clubId);
    if (!r) {
      r = { clubId, played: 0, points: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0 };
      rows.set(clubId, r);
    }
    return r;
  };
  for (const m of matches) {
    row(m.home);
    row(m.away);
    const pts = matchPoints(m);
    if (!pts) continue;
    for (const [clubId, gf, ga, p] of [
      [m.home, m.homeGoals!, m.awayGoals!, pts.home],
      [m.away, m.awayGoals!, m.homeGoals!, pts.away],
    ] as const) {
      const r = row(clubId);
      r.played += 1;
      r.points += p;
      r.goalsFor += gf;
      r.goalsAgainst += ga;
      if (p === 3) r.wins += 1;
      else if (p === 1) r.draws += 1;
      else r.losses += 1;
    }
  }
  return [...rows.values()].sort(
    (a, b) =>
      b.points - a.points ||
      b.wins - a.wins ||
      b.goalsFor - b.goalsAgainst - (a.goalsFor - a.goalsAgainst) ||
      b.goalsFor - a.goalsFor ||
      a.clubId.localeCompare(b.clubId),
  );
}

/**
 * Momento em que cada rodada fecha: o fim do último jogo dela que não foi
 * adiado. Rodada com jogo ainda por disputar (não adiado) não fecha.
 */
export function roundCloseTimes(matches: readonly Match[]): Map<number, number> {
  const byRound = new Map<number, Match[]>();
  for (const m of matches) {
    if (m.round === undefined || m.postponed || m.status === "cancelled") continue;
    const list = byRound.get(m.round) ?? [];
    list.push(m);
    byRound.set(m.round, list);
  }
  const closes = new Map<number, number>();
  for (const [round, list] of byRound) {
    if (list.some((m) => m.status !== "finished")) continue;
    closes.set(round, Math.max(...list.map(finishTime)));
  }
  return closes;
}

export function scheduleLeaguePayouts(matches: readonly Match[], rules: LeagueRules): Payout[] {
  if (matches.length === 0) return [];
  const competition = matches[0]!.competition;
  const closes = roundCloseTimes(matches);
  const closeTimes = [...closes.values()].sort((a, b) => a - b);
  const finished = matches.filter((m) => matchPoints(m) !== undefined);
  const allFinished = matches.every((m) => m.status !== "scheduled");
  const seasonClose = allFinished
    ? Math.max(...closeTimes, ...finished.map(finishTime))
    : undefined;

  // Soma os pontos por (momento de pagamento, clube).
  const pending = new Map<string, { at: number; clubId: string; points: number; rounds: Set<string> }>();
  for (const m of finished) {
    let at: number | undefined;
    if (!m.postponed) {
      at = closes.get(m.round!);
    } else {
      const t = finishTime(m);
      at = closeTimes.find((c) => c >= t) ?? seasonClose;
    }
    if (at === undefined) continue; // rodada ainda aberta: paga quando fechar
    const pts = matchPoints(m)!;
    for (const [clubId, p] of [
      [m.home, pts.home],
      [m.away, pts.away],
    ] as const) {
      if (p === 0) continue;
      const key = `${at}|${clubId}`;
      const entry = pending.get(key) ?? { at, clubId, points: 0, rounds: new Set<string>() };
      entry.points += p;
      entry.rounds.add(m.postponed ? `${m.round} (adiado)` : `${m.round}`);
      pending.set(key, entry);
    }
  }

  const payouts: Payout[] = [...pending.values()].map((e) => ({
    at: e.at,
    clubId: e.clubId,
    perShare: e.points * rules.perPoint,
    kind: "points",
    competition,
    detail: `${e.points} ponto(s), rodada ${[...e.rounds].join(", ")}`,
  }));

  if (seasonClose !== undefined) {
    computeStandings(matches).forEach((row, i) => {
      const perShare = rules.placement[i] ?? 0;
      if (perShare > 0) {
        payouts.push({
          at: seasonClose,
          clubId: row.clubId,
          perShare,
          kind: "placement",
          competition,
          detail: `${i + 1}º lugar`,
        });
      }
      // Simulação: o bônus de classificação segue a projeção pela colocação (no jogo o admin marca os classificados).
      const bonus = projectedQualification(rules, i + 1);
      if (bonus > 0) {
        payouts.push({
          at: seasonClose,
          clubId: row.clubId,
          perShare: bonus,
          kind: "qualification",
          competition,
          detail: `classificação para o ano seguinte, ${i + 1}º lugar`,
        });
      }
    });
  }

  return payouts.sort((a, b) => a.at - b.at || a.clubId.localeCompare(b.clubId));
}

export interface CupRules {
  /** Fases em ordem, ex.: ["1a-fase", ..., "final"]. */
  phases: string[];
  /** Dividendo por avançar de cada fase (chave = fase da qual o clube saiu). */
  advance: Record<string, Cents>;
  /** Valor diferente conforme a fase para onde o clube foi, ex.: { grupos: { playoffs: 30 } }. */
  advanceTo?: Record<string, Record<string, Cents>>;
  title: Cents;
}

export const COPA_DO_BRASIL: CupRules = {
  phases: ["1a-fase", "2a-fase", "3a-fase", "oitavas", "quartas", "semifinal", "final"],
  advance: {
    "1a-fase": 50,
    "2a-fase": 75,
    "3a-fase": 100,
    oitavas: 150,
    quartas: 250,
    semifinal: 400,
  },
  title: 800,
};

/** Libertadores: 1,5 vez a Copa do Brasil por fase; título R$ 12,00. */
export const LIBERTADORES: CupRules = {
  phases: ["grupos", "oitavas", "quartas", "semifinal", "final"],
  advance: { grupos: 150, oitavas: 225, quartas: 375, semifinal: 600 },
  title: 1200,
};

/**
 * Sul-Americana: 40% da Libertadores por fase; título R$ 4,80. Chegar às
 * oitavas vale R$ 0,60 pelos dois caminhos: o primeiro do grupo recebe tudo
 * nos grupos; o segundo recebe metade nos grupos e metade se vencer os playoffs.
 */
export const SULAMERICANA: CupRules = {
  phases: ["grupos", "playoffs", "oitavas", "quartas", "semifinal", "final"],
  advance: { grupos: 60, playoffs: 30, oitavas: 90, quartas: 150, semifinal: 240 },
  advanceTo: { grupos: { playoffs: 30 } },
  title: 480,
};

export function scheduleCupPayouts(matches: readonly Match[], rules: CupRules): Payout[] {
  if (matches.length === 0) return [];
  const competition = matches[0]!.competition;
  const byPhase = new Map<string, Match[]>();
  for (const m of matches) {
    if (!m.phase || m.status === "cancelled") continue;
    const list = byPhase.get(m.phase) ?? [];
    list.push(m);
    byPhase.set(m.phase, list);
  }
  const clubsIn = (list: Match[]) => new Set(list.flatMap((m) => [m.home, m.away]));

  const payouts: Payout[] = [];
  rules.phases.forEach((phase, i) => {
    const list = byPhase.get(phase);
    if (!list || list.some((m) => m.status !== "finished")) return;
    const at = Math.max(...list.map(finishTime));

    const isLast = i === rules.phases.length - 1;
    if (isLast) {
      // Título no apito final da decisão (o último jogo da final).
      const decider = [...list].sort((a, b) => finishTime(b) - finishTime(a))[0]!;
      const champion = decider.winner ?? winnerByScore(decider);
      if (champion) {
        payouts.push({
          at: finishTime(decider),
          clubId: champion,
          perShare: rules.title,
          kind: "cup-title",
          competition,
          detail: "campeão",
        });
      }
      return;
    }

    const amount = rules.advance[phase] ?? 0;
    if (amount === 0) return;
    // Quem passou aparece numa fase seguinte; pode pular uma (o primeiro do grupo
    // da Sul-Americana vai direto às oitavas, sem os playoffs).
    // Cada clube vai para a primeira fase seguinte em que aparece.
    const dest = new Map<string, string>();
    for (const p of rules.phases.slice(i + 1)) {
      for (const clubId of clubsIn(byPhase.get(p) ?? [])) if (!dest.has(clubId)) dest.set(clubId, p);
    }
    const here = clubsIn(list);
    for (const [clubId, to] of dest) {
      if (!here.has(clubId)) continue; // entrou direto numa fase seguinte
      payouts.push({
        at,
        clubId,
        perShare: rules.advanceTo?.[phase]?.[to] ?? amount,
        kind: "cup-phase",
        competition,
        detail: `avançou da fase ${phase}`,
      });
    }
  });

  return payouts.sort((a, b) => a.at - b.at || a.clubId.localeCompare(b.clubId));
}

function winnerByScore(m: Match): string | undefined {
  if (m.homeGoals === null || m.awayGoals === null || m.homeGoals === m.awayGoals) return undefined;
  return m.homeGoals > m.awayGoals ? m.home : m.away;
}

/**
 * Recompra de fim de temporada: para cada clube, `multiple` vezes a soma dos
 * dividendos por ação de `payouts` (todas as competições), paga 1 ms depois do
 * último dividendo, para vir sempre depois dele. Múltiplo zero: sem recompra.
 */
export function scheduleBuyback(payouts: readonly Payout[], multiple: number): Payout[] {
  if (multiple <= 0 || payouts.length === 0) return [];
  const at = Math.max(...payouts.map((p) => p.at)) + 1;
  const totals = new Map<string, Cents>();
  for (const p of payouts) {
    if (p.kind === "buyback") continue;
    totals.set(p.clubId, (totals.get(p.clubId) ?? 0) + p.perShare);
  }
  return [...totals]
    .map(([clubId, total]) => ({
      at,
      clubId,
      perShare: Math.round(total * multiple),
      kind: "buyback" as const,
      competition: "temporada",
      detail: `recompra: ${multiple}× os dividendos da temporada`,
    }))
    .sort((a, b) => a.clubId.localeCompare(b.clubId));
}

/**
 * Executa a recompra: paga `perShare` por ação a cada acionista (menos as
 * contas em `exclude`) e zera as ações do clube em todas as contas, inclusive
 * nas excluídas. As ordens com essas ações precisam ser canceladas antes.
 * Devolve o total pago.
 */
export function applyBuyback(ledger: Ledger, payout: Payout, exclude: ReadonlySet<string> = new Set()): Cents {
  const total = applyPayout(ledger, payout, exclude);
  for (const account of ledger.all()) {
    const shares = account.positions.get(payout.clubId)?.shares ?? 0;
    if (shares > 0) ledger.adjustShares(account.id, payout.clubId, -shares);
  }
  return total;
}

/**
 * Credita um pagamento a todos os acionistas do clube naquele momento (inclusive
 * ações presas em ordens de venda). As contas em `exclude` (a tesouraria do
 * jogo) não recebem. Devolve o total pago.
 */
export function applyPayout(ledger: Ledger, payout: Payout, exclude: ReadonlySet<string> = new Set()): Cents {
  let total = 0;
  for (const account of ledger.all()) {
    if (exclude.has(account.id)) continue;
    const shares = account.positions.get(payout.clubId)?.shares ?? 0;
    if (shares <= 0) continue;
    const amount = shares * payout.perShare;
    ledger.adjustCash(account.id, amount);
    total += amount;
  }
  return total;
}
