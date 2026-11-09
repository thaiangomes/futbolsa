import type { MyOrder } from "@futbolsa/contracts";
import { formatCents, formatInt } from "../../lib/format";
import { formatClock } from "./format";

/**
 * As ordens abertas do jogador no clube, com o botão de cancelar (Livro de ofertas, critério 16). Cancelar é aceito
 * também com o clube suspenso e durante um leilão. A reserva volta para o livre na hora (o `wallet.changed` atualiza
 * o caixa).
 */
export function MyOrders({
  orders,
  ticker,
  onCancel,
  busyId = null,
  error = null,
}: {
  orders: readonly MyOrder[];
  /** Mostra só as ordens deste clube; sem ele, todas. */
  ticker?: string;
  onCancel: (id: number) => void;
  busyId?: number | null;
  error?: string | null;
}) {
  const shown = ticker ? orders.filter((o) => o.ticker === ticker) : orders;
  return (
    <section className="card" aria-labelledby="t-minhas">
      <div className="card-h">
        <h2 className="card-t" id="t-minhas">{ticker ? `Minhas ordens no ${ticker}` : "Minhas ordens"}</h2>
        <span className="xs muted" data-testid="contagem-ordens">{orders.length} de 50 ordens abertas</span>
      </div>
      <div className="card-b stack-s" style={{ gap: 10 }}>
        {error && (
          <div className="note note-err" role="alert">
            <div>{error}</div>
          </div>
        )}
        {shown.length === 0 && <div className="small muted" data-testid="sem-ordens">Você não tem ordens abertas{ticker ? ` no ${ticker}` : ""}.</div>}
        {shown.map((o) => (
          <div key={o.id} className="row between" style={{ flexWrap: "nowrap", gap: 12 }} data-testid="ordem" data-order-id={o.id}>
            <div className="stack-s" style={{ gap: 2 }}>
              <div className="row-s">
                <span className={o.side === "buy" ? "chip chip-up" : "chip chip-down"}>{o.side === "buy" ? "Compra" : "Venda"}</span>
                <span className="b num">
                  {formatInt(o.quantity)} a {o.limitPrice === null ? "mercado" : formatCents(o.limitPrice)}
                </span>
              </div>
              <span className="xs muted">
                {formatInt(o.filled)} executadas
                {o.side === "buy" && o.reservedCash > 0 ? ` · ${formatCents(o.reservedCash)} reservados` : ""}
                {` · ${formatClock(o.createdAt)}`}
              </span>
            </div>
            <button type="button" className="btn btn-sm" disabled={busyId === o.id} onClick={() => onCancel(o.id)}>
              Cancelar
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
