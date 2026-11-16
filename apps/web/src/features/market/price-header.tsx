import type { ClubState } from "./club-state";
import { auctionNotice, changeClass, formatChange } from "./format";
import { formatCents } from "../../lib/format";
import { ClubBadgeMark } from "../portfolio/club-badge";
import { formatShares } from "../portfolio/format";
import type { MyPosition } from "../portfolio/use-positions";

/**
 * O cabeçalho da tela do clube: ticker, preço exibido, variação desde as 0h de Brasília e os avisos de estado ("em
 * jogo agora", "em leilão até 15h40", suspenso). O preço mostrado é o último negócio.
 */
export function PriceHeader({ state, name, position }: { state: ClubState; name?: string; position?: MyPosition }) {
  const { price } = state;
  const leilao = auctionNotice(state.auction);
  return (
    <section className="card" aria-label={`Preço de ${state.ticker}`}>
      <div className="card-b stack">
        <div className="row" style={{ gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <ClubBadgeMark club={{ ticker: state.ticker, name: name ?? state.ticker }} size={44} />
          <h1 className="h1" data-testid="ticker">{state.ticker}</h1>
          {state.matchMode && (
            <span className="chip chip-live" data-testid="chip-jogo">
              <span className="dot-live" />Em jogo agora
            </span>
          )}
          {leilao && (
            <span className="chip chip-live" data-testid="chip-leilao">
              <span className="dot-live" />{leilao}
            </span>
          )}
          {state.market.state === "suspended" && <span className="chip chip-down" data-testid="chip-suspenso">Suspenso</span>}
        </div>
        {name && <div className="small muted">{name}</div>}
        <div className="row" style={{ gap: 12, alignItems: "baseline" }}>
          <span className="disp num" data-testid="preco" style={{ fontSize: 44, fontWeight: 700, lineHeight: 1 }}>
            {formatCents(price.displayed)}
          </span>
          <span className={`${changeClass(price.changeBp)} b num`} data-testid="variacao" style={{ fontSize: 16 }}>
            {formatChange(price.changeBp)}
          </span>
        </div>
        <div className="small muted">Variação desde {formatCents(price.open)} às 0h de Brasília</div>
        {position && (
          <div className="small" data-testid="minha-posicao">
            {position.shares === 0 ? (
              <span className="muted">Você não tem ações do {state.ticker}.</span>
            ) : (
              <>
                Você tem <b className="num">{formatShares(position.shares)} {state.ticker}</b>
                <span className="muted">
                  {" "}· preço médio {formatCents(position.averagePrice)}
                  {position.inOrders > 0 ? ` · ${formatShares(position.inOrders)} em ordens` : ""}
                </span>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
