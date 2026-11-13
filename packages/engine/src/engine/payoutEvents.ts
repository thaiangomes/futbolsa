import {
  matchPoints,
  roundCloseTimes,
  scheduleCupPayouts,
  type CupRules,
  type LeagueRules,
} from "./dividends.js";
import type { Cents } from "./money.js";
import type { SeasonValues } from "./seasonValues.js";
import { finishTime, type Match } from "./types.js";

/**
 * Eventos de pagamento de dividendos ([[Dividendos e recompra]]), com os valores
 * da temporada e a classificação oficial recebidos por parâmetro.
 *
 * Sai de `scheduleLeaguePayouts`, `scheduleCupPayouts` e `roundCloseTimes`
 * (`dividends.ts`, que continua igual para a simulação), com duas diferenças:
 * a colocação e o acesso vêm da classificação oficial importada (não de
 * `computeStandings`) e só os clubes listados recebem.
 *
 * A recompra não está aqui: é um evento por clube, calculado depois que todas as
 * competições fecham (`buyback.ts`).
 *
 * Os jogos chegam no formato do motor (`Match`): um jogo adiado e ainda não
 * disputado é `status: "scheduled"` com `postponed: true`. Quem converte a tabela
 * `matches` (onde o adiado tem status próprio) não pode mandá-lo com outro status,
 * senão o campeonato fecharia antes de o jogo acontecer.
 */

export type PayoutEventKind = "points" | "placement" | "promotion" | "cup_phase" | "cup_title" | "buyback";

export interface PayoutEvent {
  /**
   * Identifica o evento entre versões (tipo, competição, rodada ou fase, clube):
   * a correção casa o evento antigo com o novo por ela.
   */
  key: string;
  kind: PayoutEventKind;
  clubId: string;
  competition: string;
  /** Rodada que fechou o pagamento, fase da copa, ou "fim" (jogo adiado que fecha o campeonato). */
  stage: string;
  /** Valor por ação, em centavos. */
  perShare: Cents;
  /** Instante em que o evento fecha e que define quem recebe (ms desde 1970). */
  closedAt: number;
  /** Texto para a prévia e o extrato, por exemplo "6 pontos, rodada 16, 12 (adiado)". */
  reason: string;
}

export interface EventsInput {
  /** Jogos de todas as competições da temporada. */
  matches: readonly Match[];
  /**
   * Classificação oficial final por competição (`brasileirao-a`, `brasileirao-b`):
   * os clubes na ordem oficial, inclusive os não listados da Série B. Ausente
   * enquanto não foi importada: o campeonato fecha, mas a colocação ainda não gera evento.
   */
  standings: Readonly<Record<string, readonly string[]>>;
  values: SeasonValues;
  /** Clubes listados na temporada: só eles recebem. */
  listed: ReadonlySet<string>;
}

export interface EventsResult {
  events: PayoutEvent[];
  /**
   * Instante em que cada competição de `values` fecha, ou `undefined` enquanto
   * falta jogo ou fase. A recompra só fecha quando todas têm instante.
   */
  closes: Record<string, number | undefined>;
}

const eventKey = (kind: PayoutEventKind, competition: string, stage: string, clubId: string) =>
  `${kind}|${competition}|${stage}|${clubId}`;

export function eventsFor({ matches, standings, values, listed }: EventsInput): EventsResult {
  const byCompetition = new Map<string, Match[]>();
  for (const m of matches) {
    const list = byCompetition.get(m.competition) ?? [];
    list.push(m);
    byCompetition.set(m.competition, list);
  }

  const events: PayoutEvent[] = [];
  const closes: Record<string, number | undefined> = {};

  for (const [competition, rules] of Object.entries(values.leagues)) {
    const result = leagueEvents(competition, byCompetition.get(competition) ?? [], rules, standings[competition], listed);
    events.push(...result.events);
    closes[competition] = result.closedAt;
  }
  for (const [competition, rules] of Object.entries(values.cups)) {
    const result = cupEvents(competition, byCompetition.get(competition) ?? [], rules, listed);
    events.push(...result.events);
    closes[competition] = result.closedAt;
  }

  events.sort((a, b) => a.closedAt - b.closedAt || a.clubId.localeCompare(b.clubId) || a.key.localeCompare(b.key));
  return { events, closes };
}

function pointsText(points: number): string {
  return `${points} ${points === 1 ? "ponto" : "pontos"}`;
}

/**
 * Instante em que um campeonato de pontos corridos fecha: o fim do último jogo, inclusive o adiado disputado depois
 * da última rodada; `undefined` enquanto falta jogo (ou se não há jogos). É o `closedAt` de `eventsFor` e o que a
 * entrada no meio da temporada usa para fechar a janela (`entryWindow`).
 */
export function leagueClosedAt(matches: readonly Match[]): number | undefined {
  if (matches.length === 0) return undefined;
  const closes = roundCloseTimes(matches);
  const finished = matches.filter((m) => matchPoints(m) !== undefined);
  const allDone = matches.every((m) => m.status !== "scheduled");
  const times = [...closes.values(), ...finished.map(finishTime)];
  return allDone && times.length > 0 ? Math.max(...times) : undefined;
}

function leagueEvents(
  competition: string,
  matches: readonly Match[],
  rules: LeagueRules,
  official: readonly string[] | undefined,
  listed: ReadonlySet<string>,
): { events: PayoutEvent[]; closedAt: number | undefined } {
  if (matches.length === 0) return { events: [], closedAt: undefined };

  const closes = roundCloseTimes(matches);
  const rounds = [...closes].sort((a, b) => a[1] - b[1]); // [rodada, instante], do fechamento mais cedo ao mais tarde
  const finished = matches.filter((m) => matchPoints(m) !== undefined);
  // O campeonato fecha no fim do último jogo, inclusive o adiado disputado depois da última rodada.
  const closedAt = leagueClosedAt(matches);

  // Pontos por (rodada que fecha o pagamento, clube).
  const pending = new Map<string, { stage: string; at: number; clubId: string; points: number; postponed: string[] }>();
  for (const m of finished) {
    let stage: string;
    let at: number;
    const postponedNote = m.postponed ? `${m.round} (adiado)` : undefined;
    if (!m.postponed) {
      const close = closes.get(m.round!);
      if (close === undefined) continue; // rodada ainda aberta: paga quando fechar
      stage = String(m.round);
      at = close;
    } else {
      const t = finishTime(m);
      const next = rounds.find(([, close]) => close >= t);
      if (next) {
        stage = String(next[0]);
        at = next[1];
      } else if (closedAt !== undefined) {
        stage = "fim";
        at = closedAt;
      } else {
        continue; // o campeonato ainda não fechou
      }
    }
    const pts = matchPoints(m)!;
    for (const [clubId, p] of [
      [m.home, pts.home],
      [m.away, pts.away],
    ] as const) {
      if (p === 0 || !listed.has(clubId)) continue;
      const key = `${stage}|${clubId}`;
      const entry = pending.get(key) ?? { stage, at, clubId, points: 0, postponed: [] };
      entry.points += p;
      if (postponedNote) entry.postponed.push(postponedNote);
      pending.set(key, entry);
    }
  }

  const events: PayoutEvent[] = [...pending.values()].map((e) => ({
    key: eventKey("points", competition, e.stage, e.clubId),
    kind: "points",
    clubId: e.clubId,
    competition,
    stage: e.stage,
    perShare: e.points * rules.perPoint,
    closedAt: e.at,
    reason: [pointsText(e.points), e.stage === "fim" ? undefined : `rodada ${e.stage}`, ...e.postponed]
      .filter(Boolean)
      .join(", "),
  }));

  if (closedAt !== undefined && official) {
    if (new Set(official).size !== official.length) {
      throw new Error(`A classificação oficial de ${competition} tem clube repetido`);
    }
    const promotion = competition === "brasileirao-b";
    official.forEach((clubId, i) => {
      const perShare = rules.placement[i] ?? 0;
      if (perShare <= 0 || !listed.has(clubId)) return;
      events.push({
        key: eventKey(promotion ? "promotion" : "placement", competition, "fim", clubId),
        kind: promotion ? "promotion" : "placement",
        clubId,
        competition,
        stage: "fim",
        perShare,
        closedAt,
        reason: promotion ? `acesso à Série A: ${i + 1}º na Série B` : `${i + 1}º lugar`,
      });
    });
  }

  return { events, closedAt };
}

function cupEvents(
  competition: string,
  matches: readonly Match[],
  rules: CupRules,
  listed: ReadonlySet<string>,
): { events: PayoutEvent[]; closedAt: number | undefined } {
  if (matches.length === 0) return { events: [], closedAt: undefined };

  const lastPhase = rules.phases[rules.phases.length - 1]!;

  // A copa fecha no apito final da decisão, mas só com o campeão definido: o
  // vencedor registrado (pênaltis, informados pelo admin) ou, na final em jogo
  // único, o placar. Numa final de ida e volta o placar da volta sozinho não diz
  // quem venceu no agregado. Sem campeão a copa fica aberta, e com ela a recompra,
  // em vez de fechar sem o título e depender de uma correção.
  const finalGames = matches.filter((m) => m.phase === lastPhase && m.status !== "cancelled");
  let closedAt: number | undefined;
  let champion: string | undefined;
  if (finalGames.length > 0 && finalGames.every((m) => m.status === "finished")) {
    const decider = [...finalGames].sort((a, b) => finishTime(b) - finishTime(a))[0]!;
    champion = decider.winner ?? (finalGames.length === 1 ? winnerByScore(decider) : undefined);
    if (champion !== undefined) closedAt = finishTime(decider);
  }

  const events: PayoutEvent[] = [];
  for (const p of scheduleCupPayouts(matches, rules)) {
    if (!listed.has(p.clubId)) continue;
    const isTitle = p.kind === "cup-title";
    // O título só vale para o campeão definido acima (não pelo placar de um jogo da final de ida e volta).
    if (isTitle && p.clubId !== champion) continue;
    const stage = isTitle ? lastPhase : PHASE_IN_DETAIL.exec(p.detail)?.[1];
    if (stage === undefined) throw new Error(`Não achei a fase no motivo do pagamento: "${p.detail}"`);
    const kind: PayoutEventKind = isTitle ? "cup_title" : "cup_phase";
    events.push({
      key: eventKey(kind, competition, stage, p.clubId),
      kind,
      clubId: p.clubId,
      competition,
      stage,
      perShare: p.perShare,
      closedAt: p.at,
      reason: p.detail,
    });
  }

  return { events, closedAt };
}

function winnerByScore(m: Match): string | undefined {
  if (m.homeGoals === null || m.awayGoals === null || m.homeGoals === m.awayGoals) return undefined;
  return m.homeGoals > m.awayGoals ? m.home : m.away;
}

/** O motivo que `scheduleCupPayouts` escreve para a fase vencida: "avançou da fase oitavas". */
const PHASE_IN_DETAIL = /^avançou da fase (.+)$/;
