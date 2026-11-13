"use client";

import type { HistoryResponse } from "@futbolsa/contracts";
import { useEffect, useState } from "react";
import { formatBp, formatMoney } from "../format";
import type { ApiClient } from "../../../lib/api";
import { type PortfolioApi, portfolioApi } from "../api";

const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const monthLabel = (key: string) => `${MONTHS[Number(key.slice(5, 7)) - 1] ?? key.slice(5)}/${key.slice(0, 4)}`;

/** O retorno de uma temporada, em centésimos de ponto percentual, exato (final − base) / base, arredondado para o centésimo. */
export const seasonReturnBp = (finalEquity: number, base: number) => (base === 0 ? 0 : Math.round(((finalEquity - base) * 10_000) / base));

/** O histórico de temporadas passadas no perfil (Conta e login, critério 15; prancha 6c). */
export function HistoryCard({ history }: { history: HistoryResponse }) {
  if (history.seasons.length === 0) return null;
  return (
    <section className="card" aria-labelledby="t-hist" data-testid="historico">
      <div className="card-h"><h2 className="card-t" id="t-hist">Temporadas anteriores</h2></div>
      <div className="card-b">
        <table className="tbl">
          <thead><tr><th>Ano</th><th className="r">Patrimônio final</th><th className="r">Retorno</th><th className="r">Anual</th><th>Mensais</th></tr></thead>
          <tbody>
            {history.seasons.map((s) => (
              <tr key={s.year} data-testid="temporada">
                <td className="b">{s.year}</td>
                <td className="r num">{formatMoney(s.finalEquity)}</td>
                <td className="r num">{formatBp(seasonReturnBp(s.finalEquity, s.base))}</td>
                <td className="r">{s.position === null ? "—" : `${s.position}º`}</td>
                <td className="small">{s.months.length === 0 ? "—" : s.months.map((m) => `${monthLabel(m.month)}: ${m.position}º`).join(" · ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Lê `GET /me/history` e mostra o cartão; a falha da rede some em silêncio. */
export function ProfileHistory({ api }: { api: ApiClient | PortfolioApi }) {
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  useEffect(() => {
    let alive = true;
    const client = "history" in api ? api : portfolioApi(api);
    Promise.resolve()
      .then(() => client.history()).then((h) => alive && setHistory(h)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [api]);
  return history ? <HistoryCard history={history} /> : null;
}
