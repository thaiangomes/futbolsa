import type { PayoutMarker } from "@futbolsa/contracts";

export interface PayoutEventRow {
  id: number;
  eventKey: string;
  kind: string;
  reason: string;
  perShare: number;
  closedAt: Date;
  status: string;
  supersedesId: number | null;
  approvedAt: Date | null;
  createdAt: Date;
}

/**
 * Os marcadores de dividendo (critérios 26 e 43): um por evento vigente, no fechamento (`closed_at`), com o valor por
 * ação, o motivo e o estado (aguardando aprovação ou aprovado; o valor pode mudar numa correção). Evento substituído
 * não vira marcador próprio: vale a versão atual. Uma versão nova de um evento que **já tinha sido pago** gera um
 * marcador de estorno (a diferença negativa) ou de complemento (positiva), no horário em que a versão foi criada.
 */
export function payoutMarkers(events: readonly PayoutEventRow[], from: Date, to: Date): PayoutMarker[] {
  const byId = new Map(events.map((e) => [e.id, e]));
  const out: { marker: PayoutMarker; sort: number }[] = [];
  const inWindow = (d: Date) => d.getTime() >= from.getTime() && d.getTime() <= to.getTime();
  for (const e of events) {
    const buyback = e.kind === "buyback";
    if (e.status !== "superseded" && inWindow(e.closedAt)) {
      out.push({
        marker: { at: e.closedAt.toISOString(), kind: "payout", reason: e.reason, perShare: e.perShare, status: e.status === "approved" ? "approved" : "pending", buyback },
        sort: e.closedAt.getTime(),
      });
    }
    const previous = e.supersedesId !== null ? byId.get(e.supersedesId) : undefined;
    if (previous && previous.approvedAt !== null && inWindow(e.createdAt)) {
      const diff = e.perShare - previous.perShare;
      if (diff !== 0) {
        out.push({
          marker: { at: e.createdAt.toISOString(), kind: diff < 0 ? "reversal" : "complement", reason: e.reason, perShare: diff, status: e.status === "approved" ? "approved" : "pending", buyback },
          sort: e.createdAt.getTime(),
        });
      }
    }
  }
  return out.sort((a, b) => a.sort - b.sort).map((o) => o.marker);
}
