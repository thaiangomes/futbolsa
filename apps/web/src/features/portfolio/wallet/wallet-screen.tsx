"use client";

import { type AuctionState, type EquityResponse, type MyOrder, type WalletView } from "@futbolsa/contracts";
import { useEffect, useMemo, useState } from "react";
import { ApiError } from "../../../lib/api";
import { useSession } from "../../accounts/session-provider";
import { type MarketApi, marketApi } from "../../market/api";
import { marketErrorMessage } from "../../market/order-ticket";
import { useIsNarrow } from "../../market/mobile-club";
import { useMyOrders } from "../../market/use-my-orders";
import { type PortfolioApi, portfolioApi } from "../api";
import { EquityChart } from "../equity/equity-chart";
import { Extract } from "./extract";
import { OpenOrders } from "./open-orders";
import { CompositionBar, PositionsTable, ResultsTable, SummaryCards } from "./sections";
import { useAuctions } from "./use-auctions";
import { type EntriesData, useEntries, useWallet } from "./use-wallet";
import type { EntryFilter } from "./wallet-state";

/** O patrimônio dia a dia para o gráfico: lido ao abrir e de novo quando o patrimônio atual muda. */
function useEquity(api: PortfolioApi, enabled: boolean, currentEquity: number | null): EquityResponse | null {
  const [data, setData] = useState<EquityResponse | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    api
      .equity()
      .then((d) => alive && setData(d))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [api, enabled, currentEquity]);
  return data;
}

/** A página da carteira (`/carteira`, prancha 2): resumo, gráfico de patrimônio, composição, posições, ordens e extrato. */
export function WalletScreen() {
  const { api, state } = useSession();
  const portfolio = useMemo(() => portfolioApi(api), [api]);
  const market = useMemo(() => marketApi(api), [api]);
  return <WalletContent portfolio={portfolio} market={market} logged={state.status === "ready"} />;
}

/** O miolo da tela, sem depender da sessão (os testes passam as APIs e se está logado). */
export function WalletContent({ portfolio, market, logged }: { portfolio: PortfolioApi; market: MarketApi; logged: boolean }) {
  const wallet = useWallet(portfolio, logged);
  const [filter, setFilter] = useState<EntryFilter>({});
  const entries = useEntries(portfolio, logged, filter);
  const orders = useMyOrders(market, logged);
  const auctions = useAuctions(market, logged);
  const equity = useEquity(portfolio, logged, wallet.view?.equity ?? null);
  const narrow = useIsNarrow();
  const [busy, setBusy] = useState<number | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const cancel = async (id: number) => {
    setBusy(id);
    setCancelError(null);
    try {
      await market.cancelOrder(id);
      await orders.reload();
    } catch (e) {
      setCancelError(e instanceof ApiError ? marketErrorMessage(e.code) : "Não foi possível cancelar. Tente de novo.");
    } finally {
      setBusy(null);
    }
  };

  if (wallet.error === "not_found") {
    return (
      <div className="note" role="status" data-testid="sem-carteira">
        <div>Você ainda não entrou na temporada. Quando as ofertas do IPO abrirem, sua carteira aparece aqui com R$ 100.000,00 de caixa.</div>
      </div>
    );
  }
  if (!wallet.view) {
    return wallet.error === "load" ? (
      <div className="note note-err" role="alert"><div>Não foi possível carregar a carteira. Tente de novo em instantes.</div></div>
    ) : (
      <p className="muted">Carregando…</p>
    );
  }
  return (
    <WalletBody
      view={wallet.view}
      entries={entries}
      filter={filter}
      onFilter={setFilter}
      orders={orders.orders}
      auctions={auctions}
      equity={equity}
      onCancel={(id) => void cancel(id)}
      busyId={busy}
      cancelError={cancelError}
      narrow={narrow}
    />
  );
}

type Tab = "resumo" | "posicoes" | "ordens" | "extrato";
const TABS: { id: Tab; label: string }[] = [
  { id: "resumo", label: "Resumo" },
  { id: "posicoes", label: "Posições" },
  { id: "ordens", label: "Ordens" },
  { id: "extrato", label: "Extrato" },
];

export interface WalletBodyProps {
  view: WalletView;
  entries: EntriesData;
  filter: EntryFilter;
  onFilter: (f: EntryFilter) => void;
  orders: readonly MyOrder[] | null;
  auctions: ReadonlyMap<string, AuctionState | null>;
  equity: EquityResponse | null;
  onCancel: (id: number) => void;
  busyId: number | null;
  cancelError: string | null;
  narrow: boolean;
}

/** As peças da carteira arranjadas para o computador (uma página) ou para o celular (abas Resumo, Posições, Ordens e Extrato). */
export function WalletBody(p: WalletBodyProps) {
  const [tab, setTab] = useState<Tab>("resumo");
  const tickers = p.view.results.map((r) => r.club.ticker);
  const equityChart = p.equity ? (
    <section className="card" aria-labelledby="t-pat" data-testid="patrimonio-grafico">
      <div className="card-h"><h2 className="card-t" id="t-pat">Patrimônio</h2></div>
      <div className="card-b"><EquityChart data={p.equity} short={p.narrow} /></div>
    </section>
  ) : null;
  const orders = <OpenOrders orders={p.orders} auctions={p.auctions} onCancel={p.onCancel} busyId={p.busyId} error={p.cancelError} />;
  const extract = <Extract data={p.entries} filter={p.filter} onFilter={p.onFilter} tickers={tickers} />;

  if (p.narrow) {
    return (
      <div className="stack" data-testid="carteira-celular">
        <div className="tabs" role="group" aria-label="Seções da carteira">
          {TABS.map((t) => (
            <button key={t.id} type="button" aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>
          ))}
        </div>
        {tab === "resumo" && (
          <>
            <SummaryCards view={p.view} />
            {equityChart}
            <CompositionBar view={p.view} />
            <ResultsTable view={p.view} />
          </>
        )}
        {tab === "posicoes" && <PositionsTable view={p.view} />}
        {tab === "ordens" && orders}
        {tab === "extrato" && extract}
      </div>
    );
  }
  return (
    <div className="stack" data-testid="carteira">
      <SummaryCards view={p.view} />
      <div className="g-main-aside">
        {equityChart ?? <div />}
        <CompositionBar view={p.view} />
      </div>
      <PositionsTable view={p.view} />
      <ResultsTable view={p.view} />
      {orders}
      {extract}
    </div>
  );
}
