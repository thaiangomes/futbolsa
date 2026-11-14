import type { WalletView } from "@futbolsa/contracts";
import { formatMoney } from "../format";

const dateOf = (iso: string) => new Date(iso).toLocaleDateString("pt-BR", { day: "numeric", month: "long", year: "numeric", timeZone: "America/Sao_Paulo" });

/**
 * Os avisos do fim da temporada na carteira: "negociação encerrada, recompra a receber R$ X" entre o fim da negociação
 * e a aprovação da recompra, e "temporada encerrada, o IPO de AAAA abre em…" depois do encerramento (Carteira e
 * gráficos 21; Conta e login, critérios 16 e 17).
 */
export function SeasonNotice({ view }: { view: WalletView }) {
  if (view.between) {
    const { closedYear, nextIpoOpensAt } = view.between;
    return (
      <div className="note" role="status" data-testid="aviso-temporada-encerrada">
        <div>
          Temporada {closedYear} encerrada. Sua carteira está em R$ 0,00 e sem ações.{" "}
          {nextIpoOpensAt ? `O IPO de ${closedYear + 1} abre em ${dateOf(nextIpoOpensAt)}; você recebe R$ 100.000,00 na abertura.` : `O IPO de ${closedYear + 1} ainda não tem data.`}
        </div>
      </div>
    );
  }
  if (view.buybackClosed && view.receivable > 0) {
    return (
      <div className="note note-live" role="status" data-testid="aviso-recompra-receber">
        <div>Negociação encerrada: recompra a receber {formatMoney(view.receivable)}. Cai no caixa quando o admin aprovar.</div>
      </div>
    );
  }
  return null;
}
