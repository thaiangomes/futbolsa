"use client";

import type { MyOrder, PlaceOrderResponse } from "@futbolsa/contracts";
import { useEffect, useState } from "react";
import { formatCents } from "../../lib/format";
import { NextGamesCard } from "../club-games";
import { ClubValueCard } from "../club-value";
import type { MyPosition } from "../portfolio/use-positions";
import type { MarketApi } from "./api";
import { BookPanel } from "./book-panel";
import type { ClubState } from "./club-state";
import { changeClass, formatChange } from "./format";
import { MarketStatus } from "./market-status";
import { MyOrders } from "./my-orders";
import { PriceHeader } from "./price-header";
import { OrderTicket } from "./ticket-form";
import { TradesPanel } from "./trades-panel";

/** Largura até a qual a tela do clube vira a do celular (a prancha do celular tem 390 px). */
export const MOBILE_QUERY = "(max-width: 720px)";

/** Se a tela é estreita (celular), acompanhando a janela. No servidor e sem `matchMedia`, não é. */
export function useIsNarrow(query = MOBILE_QUERY): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return narrow;
}

type Tab = "livro" | "neg" | "minhas" | "sobre";

/**
 * A tela do clube no celular (prancha "FLA3 no celular" e "Boleta no celular"): preço grande no alto, abas Livro,
 * Negócios e Minhas ordens e, embaixo, Comprar e Vender que abrem a boleta como folha por cima da tela. É o
 * arranjo das mesmas peças do computador, com a mesma lógica da boleta.
 */
export function MobileClub({
  state,
  orders,
  logged,
  api,
  onSent,
  onCancel,
  busyId,
  cancelError,
  position,
}: {
  state: ClubState;
  orders: readonly MyOrder[];
  logged: boolean;
  api: MarketApi;
  onSent: (result: PlaceOrderResponse) => void;
  onCancel: (id: number) => void;
  busyId: number | null;
  cancelError: string | null;
  position?: MyPosition;
}) {
  const [tab, setTab] = useState<Tab>("livro");
  const [sheet, setSheet] = useState<"buy" | "sell" | null>(null);
  // O preço do clique no livro, com que a folha abre (sem clique, abre no preço exibido)
  const [sheetPrice, setSheetPrice] = useState<number | undefined>(undefined);
  const openSheet = (side: "buy" | "sell", price?: number) => {
    setSheetPrice(price);
    setSheet(side);
  };
  const mine = orders.filter((o) => o.ticker === state.ticker && o.limitPrice !== null).map((o) => ({ side: o.side, limitPrice: o.limitPrice! }));
  const tabs: [Tab, string][] = [["livro", "Livro"], ["neg", "Negócios"], ...(logged ? ([["minhas", "Minhas ordens"]] as [Tab, string][]) : []), ["sobre", "Sobre"]];

  return (
    <div className="stack" data-testid="clube-celular" style={{ gap: 14 }}>
      <PriceHeader state={state} position={position} />
      <MarketStatus state={state} />
      <div className="tabs" role="group" aria-label="Seções">
        {tabs.map(([id, text]) => (
          <button key={id} type="button" aria-pressed={tab === id} onClick={() => setTab(id)}>{text}</button>
        ))}
      </div>
      {tab === "livro" && <BookPanel bids={state.bids} asks={state.asks} mine={mine} onPick={logged ? (side, price) => openSheet(side, price) : undefined} />}
      {tab === "neg" && <TradesPanel trades={state.trades} />}
      {tab === "sobre" && (
        <>
          <NextGamesCard ticker={state.ticker} api={api} />
          <ClubValueCard ticker={state.ticker} price={state.price.displayed} api={api} />
        </>
      )}
      {tab === "minhas" && logged && <MyOrders orders={orders} ticker={state.ticker} onCancel={onCancel} busyId={busyId} error={cancelError} />}

      <div className="row" style={{ padding: "12px 0", gap: 10, flexWrap: "nowrap", position: "sticky", bottom: "var(--altura-abas, 0px)", background: "var(--bg)" }}>
        <button type="button" className="btn btn-buy btn-lg grow" onClick={() => openSheet("buy")}>Comprar</button>
        <button type="button" className="btn btn-sell btn-lg grow" onClick={() => openSheet("sell")}>Vender</button>
      </div>

      {sheet && (
        <>
          <div className="scrim" onClick={() => setSheet(null)} />
          <div className="sheet" role="dialog" aria-label={`Enviar ordem · ${state.ticker}`} data-testid="folha-boleta" style={{ paddingLeft: 16, paddingRight: 16 }}>
            <div className="grab" />
            <div className="row-s" style={{ margin: "0 0 8px" }}>
              <span className="h2">{state.ticker}</span>
              <span className="disp num" style={{ fontSize: 24, fontWeight: 700 }}>{formatCents(state.price.displayed)}</span>
              <span className={`${changeClass(state.price.changeBp)} b`}>{formatChange(state.price.changeBp)}</span>
            </div>
            <OrderTicket state={state} myOrders={orders} api={api} initialSide={sheet} initialPrice={sheetPrice} onClose={() => setSheet(null)} onSent={onSent} />
          </div>
        </>
      )}
    </div>
  );
}
