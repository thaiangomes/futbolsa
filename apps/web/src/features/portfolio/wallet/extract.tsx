import { ENTRY_GROUPS, type EntryGroup } from "@futbolsa/contracts";
import type { EntriesData } from "./use-wallet";
import { EntryRow, ENTRY_GROUP_LABELS } from "./sections";
import type { EntryFilter } from "./wallet-state";

/**
 * O extrato com filtro por clube e por tipo e "carregar mais". Mostra só o que mexe no caixa ou nas ações (as linhas
 * de reserva ficam de fora; o caixa reservado está no resumo), sem a outra ponta dos negócios.
 */
export function Extract({
  data,
  filter,
  onFilter,
  tickers,
}: {
  data: EntriesData;
  filter: EntryFilter;
  onFilter: (filter: EntryFilter) => void;
  /** Os clubes do filtro: os que a carteira já teve. */
  tickers: readonly string[];
}) {
  return (
    <section className="card" aria-labelledby="t-ext" data-testid="extrato">
      <div className="card-h">
        <h2 className="card-t" id="t-ext">Extrato</h2>
        <div className="row-s">
          <label className="xs muted" htmlFor="f-clube">Clube</label>
          <select id="f-clube" className="input" value={filter.club ?? ""} onChange={(e) => onFilter({ ...filter, club: e.target.value || undefined })}>
            <option value="">Todos</option>
            {tickers.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <label className="xs muted" htmlFor="f-tipo">Tipo</label>
          <select id="f-tipo" className="input" value={filter.kind ?? ""} onChange={(e) => onFilter({ ...filter, kind: (e.target.value || undefined) as EntryGroup | undefined })}>
            <option value="">Todos</option>
            {ENTRY_GROUPS.map((g) => <option key={g} value={g}>{ENTRY_GROUP_LABELS[g]}</option>)}
          </select>
        </div>
      </div>
      {data.error && <div className="note note-err" role="alert" style={{ margin: 12 }}><div>Não foi possível carregar o extrato. Tente de novo em instantes.</div></div>}
      {!data.loaded && !data.error ? (
        <div className="card-b muted">Carregando…</div>
      ) : data.items.length === 0 ? (
        <div className="card-b small muted" data-testid="sem-extrato">Nenhum movimento{filter.club || filter.kind ? " com esse filtro" : " ainda"}.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="tbl">
            <thead>
              <tr><th>Quando</th><th>Movimento</th><th>Clube</th><th className="r">Ações</th><th className="r">Preço</th><th className="r">Valor</th><th className="r">Realizado</th><th className="r">Caixa depois</th></tr>
            </thead>
            <tbody>{data.items.map((e) => <EntryRow key={e.id} entry={e} />)}</tbody>
          </table>
        </div>
      )}
      {data.hasMore && (
        <div className="card-b">
          <button type="button" className="btn btn-sm" disabled={data.loadingMore} onClick={() => void data.loadMore()} data-testid="carregar-mais">
            {data.loadingMore ? "Carregando…" : "Carregar mais"}
          </button>
        </div>
      )}
    </section>
  );
}
