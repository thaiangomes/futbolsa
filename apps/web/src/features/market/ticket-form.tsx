"use client";

import type { MyOrder, PlaceOrderResponse } from "@futbolsa/contracts";
import { useMemo, useRef, useState } from "react";
import { ApiError } from "../../lib/api";
import { formatCents, formatInt } from "../../lib/format";
import { reaisField } from "../ipo/forms";
import type { MarketApi } from "./api";
import type { ClubState } from "./club-state";
import { auctionNotice, formatHour } from "./format";
import { marketErrorMessage, newIdempotencyKey, reviewTicket, type TicketForm } from "./order-ticket";

/**
 * A boleta do clube (Livro de ofertas, "O que o jogador vê › Limites da ordem"): limitada ou a mercado, compra ou
 * venda, com a faixa de 20% e o caixa ou as ações livres sempre à vista. Confere no navegador com o mesmo
 * `validateOrder` do motor antes de enviar, pede revisão (com o aviso "em jogo agora" e o de leilão) e manda com uma
 * `Idempotency-Key` por envio. A API refaz tudo com a carteira travada; a recusa dela aparece com a mesma mensagem.
 */
export function OrderTicket({
  state,
  myOrders,
  api,
  onSent,
  initialSide = "buy",
  onClose,
}: {
  state: ClubState;
  /** As ordens abertas do jogador em todos os clubes (o limite de 50 e a regra de ordem contra si mesmo). */
  myOrders: readonly MyOrder[];
  api: MarketApi;
  onSent?: (result: PlaceOrderResponse) => void;
  /** O lado em que a boleta abre (no celular, o botão Comprar ou Vender que o jogador tocou). */
  initialSide?: "buy" | "sell";
  /** Mostra o botão de fechar (a boleta do celular é uma folha por cima da tela). */
  onClose?: () => void;
}) {
  const [form, setForm] = useState<TicketForm>({ side: initialSide, type: "limit", quantity: "", price: reaisField(state.price.displayed) });
  const [phase, setPhase] = useState<"editing" | "reviewing" | "sending">("editing");
  const [serverError, setServerError] = useState<string | null>(null);
  const [sent, setSent] = useState<PlaceOrderResponse | null>(null);
  // A chave vale para a ordem que o jogador está revisando: um clique repetido no "Enviar" reusa a mesma chave
  // (não duplica); mudar a ordem gera outra.
  const key = useRef<string | null>(null);

  const me = state.me;
  const inAuction = state.auction !== null;
  const open = state.market.state === "open";
  const review = useMemo(() => {
    if (!me) return null;
    return reviewTicket(form, {
      displayedPrice: state.price.displayed,
      cash: me.freeCash,
      freeCash: me.freeCash,
      freeShares: me.freeShares,
      openOrders: myOrders.length,
      myOpenOrders: myOrders
        .filter((o) => o.ticker === state.ticker && o.limitPrice !== null)
        .map((o) => ({ side: o.side, limitPrice: o.limitPrice! })),
      inAuction,
      inMatch: state.matchMode,
    });
  }, [form, me, state.price.displayed, state.ticker, state.matchMode, myOrders, inAuction]);

  if (!me) {
    return (
      <section className="card" aria-labelledby="t-boleta">
        <div className="card-h"><h2 className="card-t" id="t-boleta">{`Enviar ordem · ${state.ticker}`}</h2></div>
        <div className="card-b stack-s">
          <div className="small muted">Entre na sua conta para comprar e vender.</div>
          <a className="btn btn-p" href="/entrar">Entrar</a>
        </div>
      </section>
    );
  }

  const change = (patch: Partial<TicketForm>) => {
    key.current = null;
    setServerError(null);
    setSent(null);
    setPhase("editing");
    setForm((f) => ({ ...f, ...patch }));
  };
  const buying = form.side === "buy";
  const typed = form.quantity.trim() !== "" && (form.type === "market" || form.price.trim() !== "");
  const error = serverError ?? (typed && review && !review.ok ? review.message : null);
  const marketOnly = inAuction; // em leilão a ordem a mercado é recusada: a boleta tira a opção (W7)

  const send = async () => {
    if (!review?.ok) return;
    key.current ??= newIdempotencyKey();
    setPhase("sending");
    setServerError(null);
    try {
      const result = await api.placeOrder(
        { ticker: state.ticker, ...review.order } as Parameters<MarketApi["placeOrder"]>[0],
        key.current,
      );
      setSent(result);
      setForm((f) => ({ ...f, quantity: "" }));
      key.current = null;
      setPhase("editing");
      onSent?.(result);
    } catch (e) {
      setServerError(e instanceof ApiError ? (e.code === "club_suspended" ? e.message : marketErrorMessage(e.code)) : marketErrorMessage(""));
      // Recusa da API é definitiva: a próxima tentativa é outra ordem. Falha de rede é incerta (a ordem pode ter
      // entrado): quem tenta de novo reusa a mesma chave e a API devolve a mesma resposta, sem duplicar.
      if (e instanceof ApiError) key.current = null;
      setPhase("editing");
    }
  };

  return (
    <section className="card" aria-labelledby="t-boleta">
      <div className="card-h">
        <h2 className="card-t" id="t-boleta">{`Enviar ordem · ${state.ticker}`}</h2>
        <span className="xs muted" data-testid="ordens-abertas">{myOrders.length} de 50 ordens abertas</span>
        {onClose && (
          <button type="button" className="btn btn-ghost btn-sm" aria-label="Fechar" onClick={onClose}>×</button>
        )}
      </div>
      <div className="card-b stack" data-testid="boleta">
        <div className="seg full" role="group" aria-label="Lado">
          <button type="button" className="buy" aria-pressed={buying} onClick={() => change({ side: "buy" })}>Comprar</button>
          <button type="button" className="sell" aria-pressed={!buying} onClick={() => change({ side: "sell" })}>Vender</button>
        </div>
        <div className="seg full" role="group" aria-label="Tipo">
          <button type="button" aria-pressed={form.type === "limit"} onClick={() => change({ type: "limit" })}>Limitada</button>
          {!marketOnly && (
            <button type="button" aria-pressed={form.type === "market"} onClick={() => change({ type: "market" })}>A mercado</button>
          )}
        </div>
        <div className="g-2" style={{ gap: 10 }}>
          <label className="field">
            <span className="lbl">Quantidade</span>
            <input className="input" inputMode="numeric" aria-label="Quantidade" value={form.quantity} onChange={(e) => change({ quantity: e.target.value })} />
          </label>
          {form.type === "limit" && (
            <label className="field">
              <span className="lbl">{buying ? "Preço máximo (R$)" : "Preço mínimo (R$)"}</span>
              <input className="input" inputMode="decimal" aria-label="Preço" value={form.price} onChange={(e) => change({ price: e.target.value })} />
            </label>
          )}
        </div>
        <div className="note" style={{ padding: "10px 12px" }}>
          <div className="stack-s" style={{ gap: 0, width: "100%" }}>
            <div className="kv" style={{ padding: "2px 0" }}>
              <span>Faixa aceita agora</span>
              <span data-testid="faixa">{`${formatCents(me.band.min)} a ${formatCents(me.band.max)}`}</span>
            </div>
            <div className="kv" style={{ padding: "2px 0" }}>
              <span>{buying ? "Caixa livre" : "Ações livres"}</span>
              <span data-testid="livre">{buying ? formatCents(me.freeCash) : `${formatInt(me.freeShares)} ${state.ticker}`}</span>
            </div>
          </div>
        </div>
        {inAuction && (
          <div className="note note-live" data-testid="boleta-leilao" style={{ padding: "10px 12px", fontSize: 12.5 }}>
            <div>
              <strong>{auctionNotice(state.auction)}.</strong> Só ordem limitada: ela entra no leilão e casa no preço único do fim.
            </div>
          </div>
        )}
        {error && (
          <div className="note note-err" role="alert" data-testid="erro-boleta" style={{ padding: "10px 12px" }}>
            <div>{error}</div>
          </div>
        )}
        {review?.ok && typed && (
          <div className="stack-s" style={{ gap: 0 }} data-testid="resumo">
            {review.order.type === "limit" && (
              <div className="kv"><span>Total</span><span>{formatCents(review.total)}</span></div>
            )}
            <div className="kv">
              <span>{buying ? "Fica reservado" : "Ficam reservadas"}</span>
              <span>{buying ? (review.order.type === "limit" ? formatCents(review.reserve) : "Nada: executa até o caixa livre") : `${formatInt(review.reservedShares)} ${state.ticker}`}</span>
            </div>
          </div>
        )}
        {phase === "reviewing" && review?.ok && (
          <div className="stack-s" data-testid="revisao">
            <div className="b">
              {buying ? "Comprar" : "Vender"} {formatInt(review.order.quantity)} {state.ticker}{" "}
              {review.order.type === "limit" ? `a ${formatCents(review.order.limitPrice!)}` : "a mercado"}
            </div>
            {review.inMatch && (
              <div className="note note-live" data-testid="revisao-jogo" style={{ padding: "10px 12px", fontSize: 12.5 }}>
                <span className="dot-live" style={{ marginTop: 4 }} />
                <div><strong>Em jogo agora.</strong> O preço pode mudar de repente.</div>
              </div>
            )}
            {inAuction && state.auction?.until && (
              <div className="note note-live" data-testid="revisao-leilao" style={{ padding: "10px 12px", fontSize: 12.5 }}>
                <div>Sua ordem entra no leilão até {formatHour(state.auction.until)}: nada executa agora.</div>
              </div>
            )}
            <div className="row" style={{ gap: 10 }}>
              <button type="button" className="btn grow" onClick={() => setPhase("editing")}>Voltar</button>
              <button type="button" className={`btn grow ${buying ? "btn-buy" : "btn-sell"}`} onClick={send}>Confirmar e enviar</button>
            </div>
          </div>
        )}
        {phase === "sending" && <div className="small muted" role="status">Enviando…</div>}
        {phase === "editing" && (
          <button
            type="button"
            className={`btn btn-lg btn-full ${buying ? "btn-buy" : "btn-sell"}`}
            disabled={!open || !typed || !review?.ok}
            onClick={() => setPhase("reviewing")}
          >
            {buying ? "Revisar compra" : "Revisar venda"}
          </button>
        )}
        {sent && (
          <div className="note note-ok" role="status" data-testid="enviada">
            <div>
              {sent.openedAuction
                ? `Sua ordem abriu um leilão até ${sent.auction?.until ? formatHour(sent.auction.until) : "o fim da suspensão"}: nada executou e ela entrou inteira nele.`
                : sent.trades.length > 0
                  ? `Ordem enviada: ${formatInt(sent.trades.reduce((n, t) => n + t.quantity, 0))} ações executadas. O que sobrou fica no livro.`
                  : "Ordem enviada. Ela aparece destacada no livro e em Minhas ordens."}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
