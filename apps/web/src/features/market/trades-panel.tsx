import type { PublicTrade } from "@futbolsa/contracts";
import { formatCents, formatInt } from "../../lib/format";
import { formatClock } from "./format";

/** Os 20 últimos negócios do clube, do mais recente para o mais antigo: hora, preço e quantidade, sem contraparte. */
export function TradesPanel({ trades }: { trades: readonly PublicTrade[] }) {
  return (
    <section className="card" aria-labelledby="t-neg">
      <div className="card-h">
        <h2 className="card-t" id="t-neg">Últimos negócios</h2>
        <span className="xs muted">20 mais recentes</span>
      </div>
      <div style={{ maxHeight: 372, overflowY: "auto" }}>
        <table className="tbl">
          <thead>
            <tr><th>Hora</th><th className="r">Preço</th><th className="r">Qtd.</th></tr>
          </thead>
          <tbody>
            {trades.map((t, i) => {
              const older = trades[i + 1];
              const cls = !older || t.price === older.price ? "r b" : t.price > older.price ? "r b up" : "r b down";
              return (
                <tr key={t.id} data-testid="negocio">
                  <td className="muted">{formatClock(t.at)}</td>
                  <td className={cls}>{formatCents(t.price)}</td>
                  <td className="r">{formatInt(t.quantity)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="xs muted" style={{ padding: "10px 16px", borderTop: "1px solid var(--line)" }}>
        Sem comprador nem vendedor: a contraparte de cada negócio fica escondida.
      </div>
    </section>
  );
}
