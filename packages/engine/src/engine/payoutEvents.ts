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
  const allDone = matches.every((m) => m.status !== "scheduled");
  const times = [...closes.values(), ...finished.map(finishTime)];
  // O campeonato fecha no fim do último jogo, inclusive o adiado disputado depois da última rodada.
  const closedAt = allDone && times.length > 0 ? Math.max(...times) : undefined;

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
  const events: PayoutEvent[] = [];
  for (const p of scheduleCupPayouts(matches, rules)) {
    if (!listed.has(p.clubId)) continue;
    const isTitle = p.kind === "cup-title";
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

  // A copa fecha quando termina a última fase (a decisão), mesmo sem campeão registrado.
  const decider = matches.filter((m) => m.phase === lastPhase && m.status !== "cancelled");
  const closedAt =
    decider.length > 0 && decider.every((m) => m.status === "finished")
      ? Math.max(...decider.map(finishTime))
      : undefined;
  return { events, closedAt };
}

/** O motivo que `scheduleCupPayouts` escreve para a fase vencida: "avançou da fase oitavas". */
const PHASE_IN_DETAIL = /^avançou da fase (.+)$/;
