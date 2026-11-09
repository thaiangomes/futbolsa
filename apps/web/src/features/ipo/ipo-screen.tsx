"use client";

import type { IpoApi } from "./api";
import { OfferPeriod } from "./offer-period/offer-period";
import { ResultsScreen, SettlingScreen } from "./results/results-screen";
import { ErrorNote, useNow } from "./ui";
import { useIpoData } from "./use-ipo-data";

/**
 * A tela do IPO (`/ipo`): decide o que mostrar. `GET /ipo/results` com `settled` mostra o resultado do rateio
 * (prancha 3b) e com `settling` o "liquidando…"; `pending` mostra o período de ofertas (prancha 3). Se o IPO já
 * fechou e o resultado ainda diz `pending` (a tarefa de liquidar não passou), também é "liquidando…".
 */
export function IpoScreen({ api, now = Date.now }: { api: IpoApi; now?: () => number }) {
  const data = useIpoData(api);
  const clock = useNow(now);
  const { overview, results } = data;
  if (!overview || !results) {
    return data.loading ? <p className="muted">Carregando…</p> : <ErrorNote message={data.error} />;
  }
  const afterClose = overview.status !== "preparing" && overview.status !== "ipo_open";
  return (
    <>
      <ErrorNote message={data.error} />
      {results.status === "settled" ? (
        <ResultsScreen clubs={results.clubs} tradingOpensAt={overview.tradingOpensAt} />
      ) : results.status === "settling" || afterClose ? (
        <SettlingScreen />
      ) : (
        <OfferPeriod overview={overview} api={api} now={clock} onOverview={data.update} onStale={() => void data.reload()} />
      )}
    </>
  );
}
