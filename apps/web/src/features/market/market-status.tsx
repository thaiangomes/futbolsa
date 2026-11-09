import type { ClubState } from "./club-state";
import { auctionNotice, formatHour } from "./format";

/**
 * Os avisos de estado do mercado na tela do clube (Livro de ofertas: horário, suspensão, jogo e leilão): "negociação
 * abre às 10h" antes da estreia, o motivo da suspensão, "negociação encerrada" depois do fim da temporada, "em jogo
 * agora" no modo de jogo da casa e "em leilão até 15h40" no leilão do túnel de preço, no mesmo desenho.
 */
export function MarketStatus({ state }: { state: ClubState }) {
  const notes: { id: string; live: boolean; text: string }[] = [];
  const { market } = state;
  if (market.state === "not_open") {
    notes.push({ id: "abertura", live: false, text: market.opensAt ? `A negociação abre às ${formatHour(market.opensAt)}.` : "A negociação ainda não abriu." });
  }
  if (market.state === "suspended") {
    notes.push({
      id: "suspenso",
      live: true,
      text: `Negociação suspensa${market.reason ? `: ${market.reason}` : ""}. Nenhuma ordem nova entra e nada executa; você ainda pode cancelar as suas.`,
    });
  }
  if (market.state === "ended") notes.push({ id: "encerrada", live: false, text: "Negociação encerrada: a temporada terminou." });
  const leilao = auctionNotice(state.auction);
  if (leilao && market.state !== "suspended") {
    notes.push({
      id: "leilao",
      live: true,
      text: state.auction?.until
        ? `${leilao}. Nenhum negócio sai e o preço não muda; no fim, todas as ordens casam num preço único. Só ordem limitada.`
        : `${leilao}.`,
    });
  }
  if (state.matchMode && market.state === "open") {
    notes.push({ id: "jogo", live: true, text: "Em jogo agora. A negociação continua aberta: ordens no livro podem executar logo depois de um gol." });
  }
  if (notes.length === 0) return null;
  return (
    <>
      {notes.map((n) => (
        <div key={n.id} className={n.live ? "note note-live" : "note"} role="status" data-testid={`aviso-${n.id}`}>
          <div>{n.text}</div>
        </div>
      ))}
    </>
  );
}
