import { type EventEnvelope, type MyOrder, orderUpdatedEventSchema } from "@futbolsa/contracts";

/**
 * As ordens abertas do próprio jogador: lidas de `GET /orders?status=open` e atualizadas pelo `order.updated` do
 * canal `me`. A ordem que executou por inteiro ou foi cancelada sai da lista; a que executou em parte fica com o
 * `filled` novo. Aplicar o mesmo evento duas vezes dá o mesmo estado.
 */
export type MyOrdersState = MyOrder[];

export function applyOrderEvent(orders: MyOrdersState, event: EventEnvelope): MyOrdersState {
  if (event.type !== "order.updated") return orders;
  const parsed = orderUpdatedEventSchema.safeParse(event.data);
  if (!parsed.success) return orders;
  const u = parsed.data;
  if (u.status !== "open") return orders.filter((o) => o.id !== u.id);
  const known = orders.find((o) => o.id === u.id);
  const row: MyOrder = {
    id: u.id,
    ticker: u.ticker,
    side: u.side,
    type: u.type,
    quantity: u.quantity,
    filled: u.filled,
    limitPrice: u.limitPrice,
    reservedCash: u.reservedCash,
    status: u.status,
    cancelReason: u.cancelReason,
    createdAt: known?.createdAt ?? event.at,
    updatedAt: event.at,
  };
  return known ? orders.map((o) => (o.id === u.id ? row : o)) : [...orders, row].sort((a, b) => a.id - b.id);
}
