"use client";

import type { MyOrder } from "@futbolsa/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../../lib/api";
import { formatCents, formatInt } from "../../lib/format";
import { reaisField } from "../ipo/forms";
import type { MarketApi } from "./api";
import { BookPanel } from "./book-panel";
import { auctionNotice } from "./format";
import { useIsNarrow } from "./mobile-club";
import { marketErrorMessage, newIdempotencyKey, reviewTicket } from "./order-ticket";
import { useBalances } from "./use-balances";
import { useClubBook } from "./use-club-book";

/**
 * Editar uma ordem aberta (Livro de ofertas e formador de mercado, critérios 57 a 60): só o preço e a quantidade mudam.
 * Salvar é uma troca atômica na API: a ordem antiga é cancelada e a nova entra no fim da fila daquele preço, tudo numa
 * transação; se a nova for recusada, a antiga continua como estava. Mostra o livro do clube ao vivo (tocar numa oferta
 * preenche o preço, como na boleta), a faixa aceita, o caixa ou as ações livres e a reserva nova. No computador é um
 * cartão embaixo da ordem; no celular, uma folha por cima da tela.
 */
export function EditOrderHost(props: { order: MyOrder; orders: readonly MyOrder[]; api: MarketApi; onClose: () => void; onSaved: () => void }) {
  const narrow = useIsNarrow();
  const { onClose } = props;
  // a folha do celular fecha com Esc (teclado externo) e é modal para quem usa leitor de tela
  useEffect(() => {
    if (!narrow) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [narrow, onClose]);
  if (!narrow) return <EditOrderPanel {...props} />;
  return (
    <>
      <div className="scrim" onClick={props.onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={`Editar ordem · ${props.order.ticker}`} data-testid="folha-edicao" style={{ paddingLeft: 16, paddingRight: 16, maxHeight: "88vh", overflowY: "auto" }}>
        <div className="grab" />
        <EditOrderPanel {...props} />
      </div>
    </>
  );
}

export function EditOrderPanel({ order, orders, api, onClose, onSaved }: { order: MyOrder; orders: readonly MyOrder[]; api: MarketApi; onClose: () => void; onSaved: () => void }) {
  const book = useClubBook(api, order.ticker);
  const balances = useBalances(api, order.ticker, true);
  const remaining = order.quantity - order.filled;
  const [quantity, setQuantity] = useState(String(remaining));
  const [price, setPrice] = useState(reaisField(order.limitPrice ?? 0));
  const [phase, setPhase] = useState<"editing" | "saving">("editing");
  const [error, setError] = useState<string | null>(null);
  // uma chave por edição que o jogador está revisando: um toque repetido em Salvar não troca duas vezes
  const key = useRef<string | null>(null);
  const buying = order.side === "buy";

  const state = book.state;
  const me = state?.me ?? null;
  const review = useMemo(() => {
    if (!state || !me) return null;
    // a troca devolve a reserva da ordem antiga antes de reservar a nova: o livre que vale é o de agora mais o que ela prende
    const freeCash = (balances?.freeCash ?? me.freeCash) + (buying ? order.reservedCash : 0);
    const freeShares = (balances?.freeShares ?? me.freeShares) + (buying ? 0 : remaining);
    return reviewTicket(
      { side: order.side, type: "limit", quantity, price },
      {
        displayedPrice: state.price.displayed,
        cash: freeCash,
        freeCash,
        freeShares,
        openOrders: orders.length - 1,
        myOpenOrders: orders.filter((o) => o.id !== order.id && o.ticker === order.ticker && o.limitPrice !== null).map((o) => ({ side: o.side, limitPrice: o.limitPrice! })),
        inAuction: state.auction !== null,
        inMatch: state.matchMode,
      },
    );
  }, [state, me, balances, buying, order, remaining, orders, quantity, price]);

  const change = (set: (v: string) => void, v: string) => {
    key.current = null;
    setError(null);
    set(v);
  };
  const unchanged = review?.ok === true && review.order.quantity === remaining && review.order.limitPrice === order.limitPrice;

  const save = async () => {
    if (!review?.ok || review.order.limitPrice === undefined) return;
    key.current ??= newIdempotencyKey();
    setPhase("saving");
    setError(null);
    try {
      await api.replaceOrder(order.id, { quantity: review.order.quantity, limitPrice: review.order.limitPrice }, key.current);
      key.current = null;
      onSaved();
    } catch (e) {
      // a ordem já executou ou foi cancelada (outra aba, ou a troca anterior gravou e a resposta se perdeu): a lista relê e o painel fecha
      if (e instanceof ApiError && (e.code === "order_not_open" || e.code === "order_not_found")) {
        onSaved();
        return;
      }
      setError(e instanceof ApiError ? (e.code === "club_suspended" ? e.message : marketErrorMessage(e.code)) : marketErrorMessage(""));
      if (e instanceof ApiError) key.current = null;
      setPhase("editing");
    }
  };

  return (
    <section className="card" id={`editar-ordem-${order.id}`} aria-labelledby={`t-editar-${order.id}`} data-testid="editar-ordem" style={{ marginTop: 8 }}>
      <div className="card-h">
        <h3 className="card-t" id={`t-editar-${order.id}`}>{`Editar ordem · ${order.ticker}`}</h3>
        <span className={buying ? "chip chip-up" : "chip chip-down"}>{buying ? "Compra" : "Venda"}</span>
        <button type="button" className="btn btn-ghost btn-sm" aria-label="Fechar edição" onClick={onClose}>×</button>
      </div>
      <div className="card-b stack">
        {!state ? (
          <p className="muted m0">{book.status === "error" ? "Não foi possível carregar o livro. Tente de novo em instantes." : "Carregando o livro…"}</p>
        ) : (
          <>
            <BookPanel bids={state.bids} asks={state.asks} onPick={(_side, p) => change(setPrice, reaisField(p))} />
            <span className="xs muted">Toque numa oferta do livro para usar o preço dela. O lado ({buying ? "compra" : "venda"}) e o clube não mudam.</span>
            <div className="g-2" style={{ gap: 10 }}>
              <label className="field">
                <span className="lbl">Quantidade</span>
                <input className="input" inputMode="numeric" aria-label="Quantidade" value={quantity} onChange={(e) => change(setQuantity, e.target.value)} />
                {order.filled > 0 && <span className="hint">{formatInt(order.filled)} já executadas ficam como estão; esta é a quantidade que você ainda quer.</span>}
              </label>
              <label className="field">
                <span className="lbl">{buying ? "Preço máximo (R$)" : "Preço mínimo (R$)"}</span>
                <input className="input" inputMode="decimal" aria-label="Preço" value={price} onChange={(e) => change(setPrice, e.target.value)} />
              </label>
            </div>
            {me && (
              <div className="stack-s" style={{ gap: 0 }}>
                <div className="kv"><span>Faixa aceita agora</span><span data-testid="faixa-edicao">{`${formatCents(me.band.min)} a ${formatCents(me.band.max)}`}</span></div>
                <div className="kv">
                  <span>{buying ? "Caixa livre com a ordem antiga devolvida" : "Ações livres com a ordem antiga devolvida"}</span>
                  <span data-testid="livre-edicao">
                    {buying ? formatCents((balances?.freeCash ?? me.freeCash) + order.reservedCash) : `${formatInt((balances?.freeShares ?? me.freeShares) + remaining)} ${order.ticker}`}
                  </span>
                </div>
              </div>
            )}
            {state.auction && (
              <div className="note note-live" style={{ padding: "10px 12px", fontSize: 12.5 }}><div><strong>{auctionNotice(state.auction)}.</strong> A ordem nova entra no leilão.</div></div>
            )}
            {review?.ok && (
              <div className="stack-s" style={{ gap: 0 }} data-testid="resumo-edicao">
                <div className="kv"><span>Total</span><span>{formatCents(review.total)}</span></div>
                <div className="kv">
                  <span>{buying ? "Fica reservado" : "Ficam reservadas"}</span>
                  <span data-testid="reserva-nova">{buying ? formatCents(review.reserve) : `${formatInt(review.reservedShares)} ${order.ticker}`}</span>
                </div>
              </div>
            )}
            {(error ?? (review && !review.ok ? review.message : null)) && (
              <div className="note note-err" role="alert" data-testid="erro-edicao" style={{ padding: "10px 12px" }}>
                <div>{error ?? (review && !review.ok ? review.message : "")}</div>
              </div>
            )}
            <div className="note" data-testid="aviso-fila" style={{ padding: "10px 12px", fontSize: 12.5 }}>
              <div>Ao salvar, a ordem antiga é cancelada e a nova entra no <strong>fim da fila</strong> deste preço: quem já estava nele passa na sua frente. Se a nova for recusada, a antiga continua como está.</div>
            </div>
            <div className="row" style={{ gap: 10 }}>
              <button type="button" className="btn grow" onClick={onClose}>Fechar</button>
              <button type="button" className={`btn grow ${buying ? "btn-buy" : "btn-sell"}`} data-testid="salvar-edicao" disabled={!review?.ok || unchanged || phase === "saving"} onClick={save}>
                {phase === "saving" ? "Salvando…" : "Salvar alteração"}
              </button>
            </div>
            {unchanged && <span className="xs muted">Mude o preço ou a quantidade para salvar.</span>}
          </>
        )}
      </div>
    </section>
  );
}
