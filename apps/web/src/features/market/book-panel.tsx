import type { BookLevel } from "@futbolsa/contracts";
import { formatCents, formatInt } from "../../lib/format";

/** Uma ordem aberta do próprio jogador, para destacar o nível dela no livro (só ele vê). */
export interface MarkedOrder {
  side: "buy" | "sell";
  limitPrice: number;
}

const largest = (levels: readonly BookLevel[]) => Math.max(1, ...levels.map((l) => l.quantity));
const plain = (cents: number) => formatCents(cents).replace("R$ ", "");

/**
 * O livro agregado: os 5 melhores preços de cada lado, com a quantidade somada e o número de ordens, sem apelido e
 * sem marcar a casa nem os bots. As ordens do próprio jogador aparecem destacadas só para ele (`mine`), pelo que ele
 * já conhece (`GET /orders` e o canal `me`). Em leilão o livro aparece como sempre, mesmo cruzado, sem preço teórico.
 */
export function BookPanel({ bids, asks, mine = [] }: { bids: readonly BookLevel[]; asks: readonly BookLevel[]; mine?: readonly MarkedOrder[] }) {
  const isMine = (side: "buy" | "sell", price: number) => mine.some((o) => o.side === side && o.limitPrice === price);
  const maxQty = Math.max(largest(bids), largest(asks));
  const spread = bids[0] && asks[0] ? asks[0].price - bids[0].price : null;
  return (
    <section className="card" aria-labelledby="t-livro">
      <div className="card-h">
        <h2 className="card-t" id="t-livro">Livro de ofertas</h2>
        <span className="xs muted">5 melhores preços</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
        <div style={{ borderRight: "1px solid var(--line)" }} data-testid="compras">
          <div className="bk-head">
            <span>Ord.</span>
            <span style={{ textAlign: "right" }}>Qtd.</span>
            <span style={{ textAlign: "right" }}>Compra</span>
          </div>
          {bids.map((o) => (
            <div key={o.price} className={isMine("buy", o.price) ? "bk-row bk-mine" : "bk-row"} data-testid="nivel-compra" data-mine={isMine("buy", o.price)}>
              <div className="bk-bar" style={{ right: 0, width: `${Math.round((o.quantity / maxQty) * 100)}%`, background: "var(--up-soft)" }} />
              <span className="muted">{o.orders}</span>
              <span style={{ textAlign: "right" }}>{formatInt(o.quantity)}</span>
              <span className="up b" style={{ textAlign: "right" }}>{plain(o.price)}</span>
            </div>
          ))}
        </div>
        <div data-testid="vendas">
          <div className="bk-head" style={{ gridTemplateColumns: "84px minmax(0, 1fr) 52px" }}>
            <span>Venda</span>
            <span style={{ textAlign: "right" }}>Qtd.</span>
            <span style={{ textAlign: "right" }}>Ord.</span>
          </div>
          {asks.map((o) => (
            <div
              key={o.price}
              className={isMine("sell", o.price) ? "bk-row bk-mine" : "bk-row"}
              style={{ gridTemplateColumns: "84px minmax(0, 1fr) 52px" }}
              data-testid="nivel-venda"
              data-mine={isMine("sell", o.price)}
            >
              <div className="bk-bar" style={{ left: 0, width: `${Math.round((o.quantity / maxQty) * 100)}%`, background: "var(--down-soft)" }} />
              <span className="down b">{plain(o.price)}</span>
              <span style={{ textAlign: "right" }}>{formatInt(o.quantity)}</span>
              <span className="muted" style={{ textAlign: "right" }}>{o.orders}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="card-b stack-s" style={{ borderTop: "1px solid var(--line)", padding: "12px 16px" }}>
        {spread !== null && spread >= 0 && (
          <div className="row between small">
            <span className="muted">Spread</span>
            <span className="num b" data-testid="spread">{formatCents(spread)}</span>
          </div>
        )}
        <div className="row-s xs muted">
          <span className="chip chip-me">sua</span>
          <span>Só você vê a sua ordem destacada. O livro não mostra apelidos nem quem é a casa.</span>
        </div>
      </div>
    </section>
  );
}
