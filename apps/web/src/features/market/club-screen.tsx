"use client";

import { type ReactNode, useMemo, useState } from "react";
import { tradingBand } from "@futbolsa/engine/engine/orderRules";
import { CLUBS } from "@futbolsa/engine/data/clubs";
import { ApiError } from "../../lib/api";
import { useSession } from "../accounts/session-provider";
import { ClubValueCard } from "../club-value";
import { ClubChart } from "../portfolio/chart/club-chart";
import { portfolioApi } from "../portfolio/api";
import { type MarketApi, marketApi } from "./api";
import { BookPanel } from "./book-panel";
import type { ClubState } from "./club-state";
import { MarketStatus } from "./market-status";
import { MobileClub, useIsNarrow } from "./mobile-club";
import { marketErrorMessage } from "./order-ticket";
import { MyOrders } from "./my-orders";
import { PriceHeader } from "./price-header";
import { OrderTicket } from "./ticket-form";
import { TradesPanel } from "./trades-panel";
import { useBalances } from "./use-balances";
import { useClubBook } from "./use-club-book";
import { useMyOrders } from "./use-my-orders";

/** O cliente das rotas do mercado, ligado à sessão. */
export function useMarketApi(): MarketApi {
  const { api } = useSession();
  return useMemo(() => marketApi(api), [api]);
}

const NAMES = new Map<string, string>(CLUBS.map((c) => [c.id, c.name]));

/**
 * A tela de um clube (`/clube?t=FLA3`, prancha 1 do computador): preço e variação, avisos de estado, livro de 5
 * níveis, últimos negócios, boleta e minhas ordens, tudo atualizado pelo tempo real sem recarregar a página. Quem
 * não está logado vê o livro e os negócios (públicos), mas não a boleta nem as ordens.
 */
export function ClubScreen({ ticker }: { ticker: string }) {
  const api = useMarketApi();
  const { state: session } = useSession();
  const { api: client } = useSession();
  const logged = session.status === "ready";
  const chart = useMemo(() => <ClubChart ticker={ticker} api={portfolioApi(client)} logged={logged} />, [ticker, client, logged]);
  return <ClubView ticker={ticker} api={api} logged={logged} chart={chart} />;
}

/** O miolo da tela, sem depender da sessão (os testes passam a API e se está logado). */
export function ClubView({ ticker, api, logged, chart = null }: { ticker: string; api: MarketApi; logged: boolean; chart?: ReactNode }) {
  const book = useClubBook(api, ticker);
  const mine = useMyOrders(api, logged);
  const balances = useBalances(api, ticker, logged);
  const narrow = useIsNarrow();
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  if (!book.state) {
    return book.status === "error" ? (
      <div className="note note-err" role="alert"><div>Não foi possível carregar o clube. Tente de novo em instantes.</div></div>
    ) : (
      <p className="muted">Carregando…</p>
    );
  }
  const state: ClubState = book.state;
  // A faixa anda com o preço exibido e o saldo, com o último que a boleta conhece
  const view: ClubState = state.me
    ? { ...state, me: { band: tradingBand(state.price.displayed), freeCash: balances?.freeCash ?? state.me.freeCash, freeShares: balances?.freeShares ?? state.me.freeShares } }
    : state;
  const orders = mine.orders ?? [];

  const cancel = async (id: number) => {
    setBusy(id);
    setCancelError(null);
    try {
      await api.cancelOrder(id);
      await mine.reload();
    } catch (e) {
      setCancelError(e instanceof ApiError ? marketErrorMessage(e.code) : "Não foi possível cancelar. Tente de novo.");
    } finally {
      setBusy(null);
    }
  };

  if (narrow) {
    return (
      <MobileClub state={view} orders={orders} logged={logged} api={api} onSent={() => void mine.reload()} onCancel={(id) => void cancel(id)} busyId={busy} cancelError={cancelError} />
    );
  }

  return (
    <div className="stack" data-testid="clube">
      <PriceHeader state={view} name={NAMES.get(ticker)} />
      <MarketStatus state={view} />
      {chart}
      <div className="g-livro">
        <div className="stack">
          <div className="g-2">
            <BookPanel bids={view.bids} asks={view.asks} mine={orders.filter((o) => o.ticker === ticker && o.limitPrice !== null).map((o) => ({ side: o.side, limitPrice: o.limitPrice! }))} />
            <TradesPanel trades={view.trades} />
          </div>
        </div>
        <div className="stack">
          <OrderTicket state={view} myOrders={orders} api={api} onSent={() => void mine.reload()} />
          {logged && <MyOrders orders={orders} ticker={ticker} onCancel={(id) => void cancel(id)} busyId={busy} error={cancelError} />}
        </div>
      </div>
      <ClubValueCard ticker={ticker} name={NAMES.get(ticker)} price={view.price.displayed} api={api} />
    </div>
  );
}
