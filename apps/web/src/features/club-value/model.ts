import type { ClubValueCup, ClubValueView } from "@futbolsa/contracts";
import { CHAMPION, ClubBetError, clubValue, cupMissing, type ClubBet, type ClubValueInput, type ClubValueResult } from "@futbolsa/engine/engine/clubValue";

/**
 * O "Quanto vale para você" (critério 38 do livro; T12 da F12): o cálculo é o `clubValue` do motor, o mesmo dos testes. Aqui ficam só
 * a montagem da entrada a partir do que a API devolve, as opções dos campos e os textos.
 */

/** O Brasileirão tem 38 rodadas de 3 pontos no máximo; passar disso é erro de digitação. */
export const MAX_POINTS = 38 * 3;
/** As duas séries têm 20 clubes. */
export const POSITIONS = 20;

export const CUP_NAMES: Readonly<Record<string, string>> = {
  "copa-do-brasil": "Copa do Brasil",
  libertadores: "Libertadores",
  sulamericana: "Sul-Americana",
};

/** Como a tela fala de cada fase: o nome, "em que fase está" e "onde cai". */
const PHASES: Readonly<Record<string, { name: string; at: string; falls: string }>> = {
  grupos: { name: "fase de grupos", at: "na fase de grupos", falls: "Cai na fase de grupos" },
  playoffs: { name: "playoffs", at: "nos playoffs", falls: "Cai nos playoffs" },
  "1a-fase": { name: "1ª fase", at: "na 1ª fase", falls: "Cai na 1ª fase" },
  "2a-fase": { name: "2ª fase", at: "na 2ª fase", falls: "Cai na 2ª fase" },
  "3a-fase": { name: "3ª fase", at: "na 3ª fase", falls: "Cai na 3ª fase" },
  oitavas: { name: "oitavas", at: "nas oitavas", falls: "Cai nas oitavas" },
  quartas: { name: "quartas", at: "nas quartas", falls: "Cai nas quartas" },
  semifinal: { name: "semifinal", at: "na semifinal", falls: "Cai na semifinal" },
  final: { name: "final", at: "na final", falls: "Perde a final" },
};

/** O nome da fase como a tela fala (`oitavas`, `fase de grupos`). */
export function phaseName(phase: string): string {
  return PHASES[phase]?.name ?? phase;
}

/** O que o jogador digitou e escolheu. */
export interface BetForm {
  points: string;
  position: string;
  /** Por copa, a fase em que o clube cai (ou `campeao`). */
  cups: Record<string, string>;
}

/** A entrada do motor: os valores da temporada que a API devolveu e o preço exibido agora. */
export function toInput(view: ClubValueView, displayedPrice: number): ClubValueInput {
  return {
    values: {
      leagues: { [view.league]: view.leagueRules },
      cups: Object.fromEntries(
        view.cups.map((c) => [c.competition, { phases: c.phases, advance: c.advance, ...(c.advanceTo ? { advanceTo: c.advanceTo } : {}), title: c.title }]),
      ),
    },
    league: view.league,
    leagueOpen: view.leagueOpen,
    paid: view.paid,
    toReceive: view.toReceive,
    points: view.points,
    buybackMultipleBp: view.buybackMultipleBp,
    displayedPrice,
    cups: view.cups.map((c) => ({ competition: c.competition, currentPhase: c.currentPhase })),
  };
}

/** A aposta de partida: o clube termina como está (pontos e colocação de agora; cai já na fase em que está). */
export function initialForm(view: ClubValueView): BetForm {
  return {
    points: String(view.points),
    position: String(view.position ?? Math.ceil(POSITIONS / 2)),
    cups: Object.fromEntries(view.cups.filter((c) => c.currentPhase !== null).map((c) => [c.competition, c.currentPhase!])),
  };
}

/** As opções de uma copa: onde o clube pode cair, da fase em que está até a final, e ser campeão, com o que cada uma soma. */
export function cupOptions(cup: ClubValueCup): Array<{ value: string; label: string; extra: number }> {
  if (cup.currentPhase === null) return [];
  const rules = { phases: cup.phases, advance: cup.advance, ...(cup.advanceTo ? { advanceTo: cup.advanceTo } : {}), title: cup.title };
  const from = cup.phases.indexOf(cup.currentPhase);
  const last = cup.phases.length - 1;
  const falls = cup.phases.slice(from).map((phase) => ({ value: phase, label: PHASES[phase]?.falls ?? `Cai na ${phase}` }));
  return [...falls, { value: CHAMPION, label: "Campeão" }].map((o) => ({ ...o, extra: cupMissing(rules, cup.currentPhase!, o.value) }));
}

/** A frase do estado atual da copa (`está nas oitavas`, `já caiu`). */
export function cupStateText(cup: ClubValueCup): string {
  if (cup.currentPhase === null) return "o clube já caiu ou a copa acabou para ele";
  return `está ${PHASES[cup.currentPhase]?.at ?? `na ${cup.currentPhase}`}`;
}

export type Simulation = { ok: true; result: ClubValueResult } | { ok: false; message: string };

/** Roda o motor com o que o jogador pôs no formulário. Aposta que não faz sentido volta com o motivo, em português. */
export function simulate(view: ClubValueView, displayedPrice: number, form: BetForm): Simulation {
  const input = toInput(view, displayedPrice);
  let points = view.points;
  let position = view.position ?? 1;
  if (view.leagueOpen) {
    const text = form.points.trim();
    if (!/^\d+$/.test(text) || Number(text) > MAX_POINTS) {
      return { ok: false, message: `Use um número inteiro de ${view.points} a ${MAX_POINTS} para os pontos.` };
    }
    points = Number(text);
    position = Number(form.position);
  }
  const bet: ClubBet = { points, position, cups: Object.fromEntries(Object.entries(form.cups).filter(([, v]) => v !== "")) };
  try {
    return { ok: true, result: clubValue(input, bet) };
  } catch (error) {
    if (error instanceof ClubBetError) return { ok: false, message: error.message };
    throw error;
  }
}

