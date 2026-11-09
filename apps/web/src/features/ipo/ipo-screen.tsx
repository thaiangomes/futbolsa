"use client";

import type { IpoApi } from "./api";
import { OfferPeriod } from "./offer-period/offer-period";
import { ErrorNote, useNow } from "./ui";
import { useIpoData } from "./use-ipo-data";

/**
 * A tela do IPO (`/ipo`): decide o que mostrar. Hoje é o período de ofertas (antes da abertura, aberto
 * ou, depois do fechamento, só leitura).
 */
export function IpoScreen({ api, now = Date.now }: { api: IpoApi; now?: () => number }) {
  const data = useIpoData(api);
  const clock = useNow(now);
  if (!data.overview) {
    return data.loading ? <p className="muted">Carregando…</p> : <ErrorNote message={data.error} />;
  }
  return (
    <>
      <ErrorNote message={data.error} />
      <OfferPeriod overview={data.overview} api={api} now={clock} onOverview={data.update} onStale={() => void data.reload()} />
    </>
  );
}
