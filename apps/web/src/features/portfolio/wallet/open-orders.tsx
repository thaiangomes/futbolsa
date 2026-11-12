import type { AuctionState, MyOrder } from "@futbolsa/contracts";
import { formatCents, formatInt } from "../../../lib/format";
import { formatClock } from "../../market/format";
import { AuctionChip } from "./sections";

/**
 * As ordens abertas da carteira (critério 18): 1.000 pedidas, 400 executadas, 600 restantes; a cancelada sai da lista e o
 * extrato mantém o que já executou. O clube em leilão mostra o aviso e a ordem que entrou nele fica "aguardando o leilão".
 */
export function OpenOrders({
  orders,
  auctions,
  onCancel,
  busyId = null,
  error = null,
}: {
  orders: readonly MyOrder[] | null;
  /** O leilão de cada clube (por ticker), vivo pelo canal `prices`. */
  auctions: ReadonlyMap<string, AuctionState | null>;
  onCancel: (id: number) => void;
  busyId?: number | null;
  error?: string | null;
}) {
  return (
    <section className="card" aria-labelledby="t-ordens" data-testid="ordens-abertas">
      <div className="card-h">
        <h2 className="card-t" id="t-ordens">Ordens abertas</h2>
        {orders && <span className="xs muted">{orders.length} de 50</span>}
      </div>
      <div className="card-b stack-s" style={{ gap: 10 }}>
        {error && <div className="note note-err" role="alert"><div>{error}</div></div>}
        {orders === null ? (
          <div className="muted">Carregando…</div>
        ) : orders.length === 0 ? (
          <div className="small muted" data-testid="sem-ordens-abertas">Você não tem ordens abertas.</div>
        ) : (
          orders.map((o) => {
            const auction = auctions.get(o.ticker) ?? null;
            const rest = o.quantity - o.filled;
            return (
              <div key={o.id} className="row between" style={{ flexWrap: "nowrap", gap: 12 }} data-testid="ordem-aberta" data-order-id={o.id}>
                <div className="stack-s" style={{ gap: 2 }}>
                  <div className="row-s">
                    <span className={o.side === "buy" ? "chip chip-up" : "chip chip-down"}>{o.side === "buy" ? "Compra" : "Venda"}</span>
                    <span className="b">{o.ticker}</span>
                    <span className="b num">{formatInt(o.quantity)} a {o.limitPrice === null ? "mercado" : formatCents(o.limitPrice)}</span>
                  </div>
                  <span className="xs muted" data-testid="andamento-ordem">
                    {formatInt(o.quantity)} pedidas · {formatInt(o.filled)} executadas · {formatInt(rest)} restantes
                    {o.side === "buy" && o.reservedCash > 0 ? ` · ${formatCents(o.reservedCash)} reservados` : ""} · {formatClock(o.createdAt)}
                  </span>
                  {auction && (
                    <span className="row-s">
                      <AuctionChip auction={auction} />
                      {o.filled === 0 && <span className="xs muted" data-testid="aguardando-leilao">aguardando o leilão</span>}
                    </span>
                  )}
                </div>
                <button type="button" className="btn btn-sm" disabled={busyId === o.id} onClick={() => onCancel(o.id)}>Cancelar</button>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
