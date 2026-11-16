import { buybackPerShare } from "./buyback.js";
import type { CupRules } from "./dividends.js";
import type { Cents } from "./money.js";
import type { SeasonValues } from "./seasonValues.js";

/**
 * "Quanto vale para você" (Livro de ofertas e formador de mercado, critério 38; plano da F12, T12): o simulador da tela do clube.
 *
 * Com os valores fixos da temporada e o que o jogador apostou (pontos no fim do Brasileirão, colocação final e até onde o
 * clube vai em cada copa que ainda disputa), calcula os dividendos que faltam por origem, a recompra no fim, o valor por
 * ação na conta dele (dividendos que faltam + recompra) e a distância do preço exibido. Não usa nem mostra o valor justo
 * da casa. Função pura, sem relógio nem banco: o site roda a mesma conta que o teste, e a API só entrega os insumos.
 */

/** Marcador de "o clube é campeão" no lugar da fase em que cai. */
export const CHAMPION = "campeao";

export interface ClubCupState {
  /** `copa-do-brasil`, `libertadores` ou `sulamericana`. */
  competition: string;
  /** Fase em que o clube está agora; `null` quando já caiu (ou já acabou): não ganha mais nada dela. */
  currentPhase: string | null;
}

export interface ClubValueInput {
  values: SeasonValues;
  /** O campeonato do clube na temporada: `brasileirao-a` ou `brasileirao-b`. */
  league: string;
  /** Falso quando o campeonato já fechou: a colocação e os pontos já foram pagos e a aposta neles não vale. */
  leagueOpen: boolean;
  /** Dividendos já pagos e a receber por ação, de `perShareTotals`. */
  paid: Cents;
  toReceive: Cents;
  /** Pontos do clube no campeonato agora. */
  points: number;
  /** Múltiplo da recompra em pontos-base (15.000 = 1,5×). */
  buybackMultipleBp: number;
  /** O preço exibido do clube. */
  displayedPrice: Cents;
  cups: readonly ClubCupState[];
}

export interface ClubBet {
  /** Pontos do clube no fim do campeonato. */
  points: number;
  /** Colocação final (1 a N). */
  position: number;
  /** Por copa: a fase em que o clube cai (a última que disputa) ou `CHAMPION`. Sem chave: cai já na fase em que está. */
  cups: Readonly<Record<string, string>>;
}

export interface ClubValueSimulation {
  /** Dividendos que faltam, por origem. */
  missing: { points: Cents; placement: Cents; cups: Record<string, Cents>; toReceive: Cents; total: Cents };
  /** Total pago na temporada se a aposta se confirmar: o que já foi pago mais o que falta. */
  seasonTotal: Cents;
  /** Recompra de 1,5× o total da temporada, com meio centavo para cima. */
  buyback: Cents;
  /** Valor por ação na conta do jogador: dividendos que faltam + recompra. */
  value: Cents;
  /** O preço exibido contra o valor da conta, medido a partir do preço (o que o jogador ganha ou perde); `null` com valor zero. */
  outlook: PriceOutlook | null;
}

/**
 * Preço abaixo do valor: `upside` = valor ÷ preço − 1. Preço acima: `downside` = 1 − valor ÷ preço. Igual: `even`.
 * Percentual inteiro, com meio ponto para longe do zero (critério 38 de Livro de ofertas e formador de mercado).
 */
export interface PriceOutlook {
  kind: "upside" | "downside" | "even";
  percent: number;
}

export interface ClubValueResult {
  /** A recompra se a temporada acabasse agora: múltiplo × (pago + a receber). */
  buybackNow: Cents;
  simulation: ClubValueSimulation | null;
}

export type ClubBetErrorCode = "points_below_current" | "invalid_points" | "invalid_position" | "unknown_cup" | "cup_eliminated" | "phase_before_current" | "unknown_phase";

/** Aposta que não faz sentido; `message` já vem em português para a tela. */
export class ClubBetError extends Error {
  constructor(
    readonly code: ClubBetErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ClubBetError";
  }
}

/** A recompra se a temporada acabasse agora (a primeira linha do cartão). */
export function buybackIfEndedNow(paid: Cents, toReceive: Cents, buybackMultipleBp: number): Cents {
  return buybackPerShare(paid + toReceive, buybackMultipleBp);
}

/**
 * Quanto a copa ainda paga a um clube que está em `current` e cai em `fall` (ou é campeão). Soma o valor de passar de cada
 * fase, da atual até a anterior à da queda. Numa copa com caminhos diferentes (a Sul-Americana: o 1º do grupo vai direto às
 * oitavas, o 2º passa pelos playoffs), a fase que só alguns disputam (destino de `advanceTo`) só entra na conta de quem cai
 * nela ou já está nela; para quem passa por cima, vale o valor do caminho principal, que é o mesmo total (o teste de
 * `validateCupTable` garante).
 */
export function cupMissing(rules: CupRules, current: string, fall: string): Cents {
  const { phases } = rules;
  const from = phases.indexOf(current);
  const toChampion = fall === CHAMPION;
  const to = toChampion ? phases.length - 1 : phases.indexOf(fall);
  if (from < 0 || to < 0) throw new ClubBetError("unknown_phase", `A fase "${from < 0 ? current : fall}" não existe nesta copa.`);
  if (to < from) throw new ClubBetError("phase_before_current", "O clube não pode cair numa fase antes da que está.");

  const variant = new Set(Object.values(rules.advanceTo ?? {}).flatMap((m) => Object.keys(m)));
  let total = 0;
  let i = from;
  while (i < to) {
    const here = phases[i]!;
    const next = phases[i + 1]!;
    if (variant.has(next) && next !== fall) {
      // passa por cima da fase que só alguns disputam: vale o caminho principal
      total += rules.advance[here] ?? 0;
      i += 2;
    } else {
      total += rules.advanceTo?.[here]?.[next] ?? rules.advance[here] ?? 0;
      i += 1;
    }
  }
  if (toChampion) total += rules.title;
  return total;
}

function checkBet(input: ClubValueInput, bet: ClubBet): void {
  if (input.leagueOpen) {
    if (!Number.isInteger(bet.points) || bet.points < 0) throw new ClubBetError("invalid_points", "Os pontos devem ser um número inteiro, de zero para cima.");
    if (bet.points < input.points) throw new ClubBetError("points_below_current", `O clube já tem ${input.points} pontos: o fim do campeonato não pode ter menos.`);
    if (!Number.isInteger(bet.position) || bet.position < 1) throw new ClubBetError("invalid_position", "A colocação deve ser um número inteiro, de 1 para cima.");
  }
  const known = new Map(input.cups.map((c) => [c.competition, c]));
  for (const [competition, stage] of Object.entries(bet.cups)) {
    const cup = known.get(competition);
    if (!cup) throw new ClubBetError("unknown_cup", `O clube não disputa a copa "${competition}".`);
    if (cup.currentPhase === null) throw new ClubBetError("cup_eliminated", "O clube já caiu dessa copa: ela não paga mais nada.");
    const rules = input.values.cups[competition];
    if (!rules) throw new ClubBetError("unknown_cup", `A copa "${competition}" não tem valores nesta temporada.`);
    if (stage !== CHAMPION && !rules.phases.includes(stage)) throw new ClubBetError("unknown_phase", `A fase "${stage}" não existe nesta copa.`);
  }
}

/**
 * O valor do clube para o jogador. Sem `bet`, só a recompra se a temporada acabasse agora. Com `bet` incoerente (pontos abaixo
 * dos atuais, fase antes da atual, copa que o clube não disputa ou já deixou), lança `ClubBetError` com o motivo.
 */
export function clubValue(input: ClubValueInput, bet?: ClubBet): ClubValueResult {
  const buybackNow = buybackIfEndedNow(input.paid, input.toReceive, input.buybackMultipleBp);
  if (!bet) return { buybackNow, simulation: null };
  checkBet(input, bet);

  const league = input.values.leagues[input.league];
  let points = 0;
  let placement = 0;
  if (input.leagueOpen && league) {
    points = (bet.points - input.points) * league.perPoint;
    placement = league.placement[bet.position - 1] ?? 0;
  }

  const cups: Record<string, Cents> = {};
  for (const cup of input.cups) {
    const rules = input.values.cups[cup.competition];
    if (!rules || cup.currentPhase === null) continue;
    const fall = bet.cups[cup.competition] ?? cup.currentPhase;
    cups[cup.competition] = cupMissing(rules, cup.currentPhase, fall);
  }

  const cupsTotal = Object.values(cups).reduce((a, b) => a + b, 0);
  const total = points + placement + cupsTotal + input.toReceive;
  const seasonTotal = input.paid + total;
  const buyback = buybackPerShare(seasonTotal, input.buybackMultipleBp);
  const value = total + buyback;
  const outlook = value > 0 ? outlookOf(input.displayedPrice, value) : null;
  return { buybackNow, simulation: { missing: { points, placement, cups, toReceive: input.toReceive, total }, seasonTotal, buyback, value, outlook } };
}

/** Upside ou downside em percentual inteiro, calculado só com inteiros. */
function outlookOf(price: Cents, value: Cents): PriceOutlook {
  if (price === value) return { kind: "even", percent: 0 };
  const diff = Math.abs(value - price);
  const percent = Math.floor((diff * 200 + price) / (2 * price));
  return { kind: value > price ? "upside" : "downside", percent };
}
