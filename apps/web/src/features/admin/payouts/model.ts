import { type ApprovePayoutsResponse, type CorrectionPreview, correctionPreviewSchema, type PayoutEventView } from "@futbolsa/contracts";
import { ApiError } from "../../../lib/api";
import { COMPETITION_LABELS } from "../forms";

export const KIND_LABELS: Record<PayoutEventView["kind"], string> = {
  points: "Pontos da rodada",
  placement: "Colocação final",
  promotion: "Acesso",
  cup_phase: "Fase da copa",
  cup_title: "Título da copa",
  buyback: "Recompra",
};

export type EventStateKind = "blocked" | "pending" | "settling" | "settled" | "superseded";

/** A situação do evento na lista (prancha 7a): o bloqueio pela classificação não conferida vem antes do "aguardando". */
export function eventState(e: PayoutEventView): { kind: EventStateKind; label: string; chip: string } {
  if (e.status === "superseded") return { kind: "superseded", label: "Substituído", chip: "chip" };
  if (e.status === "pending") {
    return e.standingsConfirmed === false
      ? { kind: "blocked", label: "Bloqueado: classificação não conferida", chip: "chip chip-down" }
      : { kind: "pending", label: "Aguardando aprovação", chip: "chip chip-live" };
  }
  if (e.settlement.state === "settling") {
    return { kind: "settling", label: `Liquidando ${e.settlement.credited} de ${e.settlement.expected} carteiras`, chip: "chip chip-live" };
  }
  return { kind: "settled", label: "Liquidado", chip: "chip chip-up" };
}

export const canApprove = (e: PayoutEventView): boolean => eventState(e).kind === "pending";

/** "Série A · rodada 16", "Copa do Brasil · oitavas" ou "Temporada" (colocação e acesso não têm rodada). */
export function groupLabel(e: Pick<PayoutEventView, "competition" | "round" | "phase">): string {
  const name = e.competition ? (COMPETITION_LABELS[e.competition] ?? e.competition) : "Temporada";
  if (e.round !== null) return `${name} · rodada ${e.round}`;
  if (e.phase) return `${name} · ${e.phase}`;
  return name;
}

export interface EventGroup {
  label: string;
  events: PayoutEventView[];
  total: number;
  pending: number;
}

/** Agrupa por competição e rodada ou fase, na ordem em que aparecem; só o que está vigente (sem os substituídos). */
export function groupEvents(events: readonly PayoutEventView[]): EventGroup[] {
  const groups = new Map<string, EventGroup>();
  for (const e of events) {
    if (e.status === "superseded") continue;
    const label = groupLabel(e);
    const g = groups.get(label) ?? { label, events: [], total: 0, pending: 0 };
    g.events.push(e);
    g.total += e.total;
    if (e.status === "pending") g.pending += 1;
    groups.set(label, g);
  }
  return [...groups.values()];
}

/** Algum evento ainda sendo creditado: a tela recarrega sozinha até acabar. */
export const anySettling = (events: readonly PayoutEventView[]): boolean => events.some((e) => eventState(e).kind === "settling");

const OUTCOME_LABELS: Record<string, string> = {
  approved: "aprovado",
  already_approved: "já estava aprovado",
  event_superseded: "substituído por uma versão nova",
  standings_not_confirmed: "classificação não conferida",
  not_found: "não encontrado",
};

/** O resumo de uma aprovação em lista: quantos saíram e o que ficou para trás e por quê. */
export function approvalSummary(response: ApprovePayoutsResponse): string {
  const ok = response.results.filter((r) => r.outcome === "approved").length;
  const rest = response.results.filter((r) => r.outcome !== "approved");
  const base = `${ok} ${ok === 1 ? "evento aprovado" : "eventos aprovados"}`;
  if (rest.length === 0) return `${base}. Os créditos saem em lotes: acompanhe em "Liquidando".`;
  const why = new Map<string, number>();
  for (const r of rest) why.set(r.outcome, (why.get(r.outcome) ?? 0) + 1);
  return `${base}; ficaram de fora ${[...why].map(([o, n]) => `${n} (${OUTCOME_LABELS[o] ?? o})`).join(", ")}.`;
}

/** A prévia nova que vem junto do 409 `correction_stale`; `null` se o erro é outro ou a API não conseguiu calculá-la. */
export function stalePreview(error: unknown): { preview: CorrectionPreview | null } | null {
  if (!(error instanceof ApiError) || error.code !== "correction_stale") return null;
  const parsed = correctionPreviewSchema.safeParse(error.extra?.preview);
  return { preview: parsed.success ? parsed.data : null };
}

/** As linhas que não estavam na prévia anterior (ou mudaram): a tela as marca depois do "prévia desatualizada". */
export function newChangeKeys(before: CorrectionPreview, after: CorrectionPreview): Set<string> {
  const was = new Map(before.changes.map((c) => [c.key, `${c.before}/${c.after}/${c.closedAtAfter}`]));
  return new Set(after.changes.filter((c) => was.get(c.key) !== `${c.before}/${c.after}/${c.closedAtAfter}`).map((c) => c.key));
}
