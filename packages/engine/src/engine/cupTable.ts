import type { CupRules } from "./dividends.js";

/**
 * Confere a tabela de fases e valores de uma copa ([[Dividendos e recompra]]),
 * montada pelo admin a cada temporada. Cada copa é validada sozinha: os valores
 * de uma competição são definidos separadamente das outras (decisão do Thaian
 * em 2026-10-31). Devolve as violações, com o motivo em português; lista vazia
 * quer dizer que a tabela vale. Quem chama decide o que fazer: a tela do admin só
 * avisa, e o admin pode confirmar mesmo assim.
 *
 * Regras:
 * - o valor cresce a cada fase, medido pelo caminho principal (as fases que só o
 *   2º do grupo da Sul-Americana disputa, como os playoffs, não entram nessa
 *   comparação);
 * - quando uma fase tem variantes, os dois caminhos até a fase seguinte pagam o
 *   mesmo total (Sul-Americana: 0,30 + 0,30 = 0,60, igual ao 1º do grupo);
 * - o título vale o dobro da semifinal;
 * - as fases preliminares não pagam;
 * - a derrota não paga: a tabela não tem campo para isso.
 */

export interface CupTableViolation {
  code:
    | "invalid_value"
    | "unknown_phase"
    | "missing_title"
    | "preliminary_pays"
    | "not_increasing"
    | "paths_differ"
    | "title_not_double_semifinal";
  message: string;
}

const PRELIMINARY = /^(pre-|preliminar)/i;

const reais = (cents: number) => `R$ ${(cents / 100).toFixed(2).replace(".", ",")}`;

export function validateCupTable(rules: CupRules): CupTableViolation[] {
  const problems: CupTableViolation[] = [];
  const add = (code: CupTableViolation["code"], message: string) => problems.push({ code, message });

  const isCents = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
  const advance = rules.advance;
  const advanceTo = rules.advanceTo ?? {};

  // Valores: centavos inteiros e não negativos; chaves que são fases da copa.
  const validAdvance = new Map<string, number>();
  for (const [phase, value] of Object.entries(advance)) {
    if (!rules.phases.includes(phase)) {
      add("unknown_phase", `"${phase}" tem valor mas não é uma fase desta copa`);
      continue;
    }
    if (!isCents(value)) {
      add("invalid_value", `O valor da fase "${phase}" deve ser um inteiro não negativo em centavos`);
      continue;
    }
    validAdvance.set(phase, value);
  }
  for (const [from, destinations] of Object.entries(advanceTo)) {
    for (const [to, value] of Object.entries(destinations)) {
      if (!rules.phases.includes(from) || !rules.phases.includes(to)) {
        add("unknown_phase", `O caminho "${from}" → "${to}" usa uma fase que não é desta copa`);
      } else if (!isCents(value)) {
        add("invalid_value", `O valor do caminho "${from}" → "${to}" deve ser um inteiro não negativo em centavos`);
      }
    }
  }
  if (!isCents(rules.title) || rules.title <= 0) {
    add("missing_title", "O título precisa de um valor positivo em centavos");
  }

  // Preliminares não pagam.
  const paying = new Set<string>();
  for (const [phase, value] of validAdvance) if (value > 0) paying.add(phase);
  for (const [from, destinations] of Object.entries(advanceTo)) {
    for (const [to, value] of Object.entries(destinations)) {
      if (isCents(value) && value > 0) {
        paying.add(from);
        paying.add(to);
      }
    }
  }
  for (const phase of paying) {
    if (PRELIMINARY.test(phase)) {
      add("preliminary_pays", `A fase preliminar "${phase}" não paga dividendo`);
    }
  }

  // Dois caminhos até a fase seguinte pagam o mesmo total.
  const lateral = new Set<string>();
  for (const [from, destinations] of Object.entries(advanceTo)) {
    for (const [to, viaValue] of Object.entries(destinations)) {
      lateral.add(to);
      const direct = validAdvance.get(from);
      const onward = validAdvance.get(to);
      if (direct === undefined || onward === undefined || !isCents(viaValue)) continue;
      if (viaValue + onward !== direct) {
        add(
          "paths_differ",
          `Os dois caminhos de "${from}" até a fase seguinte devem pagar o mesmo: ${reais(direct)} direto, ` +
            `mas ${reais(viaValue)} + ${reais(onward)} pela fase "${to}"`,
        );
      }
    }
  }

  // O valor cresce a cada fase do caminho principal, até o título.
  let previous: { phase: string; value: number } | undefined;
  for (const phase of rules.phases) {
    const value = validAdvance.get(phase);
    if (lateral.has(phase) || value === undefined || value <= 0) continue;
    if (previous && value <= previous.value) {
      add(
        "not_increasing",
        `O valor da fase "${phase}" (${reais(value)}) deve ser maior que o da fase "${previous.phase}" (${reais(previous.value)})`,
      );
    }
    previous = { phase, value };
  }
  if (previous && isCents(rules.title) && rules.title > 0 && rules.title <= previous.value) {
    add(
      "not_increasing",
      `O título (${reais(rules.title)}) deve valer mais que a fase "${previous.phase}" (${reais(previous.value)})`,
    );
  }

  // O título vale o dobro da semifinal.
  if (rules.phases.includes("semifinal") && isCents(rules.title)) {
    const semifinal = validAdvance.get("semifinal") ?? 0;
    if (rules.title !== 2 * semifinal) {
      add(
        "title_not_double_semifinal",
        `O título (${reais(rules.title)}) deve valer o dobro da semifinal (${reais(2 * semifinal)})`,
      );
    }
  }

  return problems;
}
