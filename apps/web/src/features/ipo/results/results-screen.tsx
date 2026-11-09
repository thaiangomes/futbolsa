"use client";

import type { IpoClubResult } from "@futbolsa/contracts";
import { formatCents, formatInstant, formatInt } from "../../../lib/format";
import { Card, Cell } from "../ui";

/** "2/3", ou "1/1 (sem rateio)" quando a demanda coube na oferta. */
function ratioText(ratio: IpoClubResult["ratio"]): string {
  return ratio.num === ratio.den ? `${ratio.num}/${ratio.den} (sem rateio)` : `${ratio.num}/${ratio.den}`;
}

function ResultCard({ club }: { club: IpoClubResult }) {
  const mine = club.myAllocation;
  return (
    <li className="ipo-card ipo-result" data-ticker={club.ticker}>
      <div className="ipo-id">
        <span className="chip">{club.ticker}</span>
        <b>{club.name}</b>
      </div>
      <div className="ipo-cells ipo-cells-4">
        <Cell label="Preço de corte">{formatCents(club.cutPrice)}</Cell>
        <Cell label="Demanda no preço">{formatInt(club.demandAtCut)} ações</Cell>
        <Cell label="Fração do rateio">{ratioText(club.ratio)}</Cell>
        <Cell label="Tesouraria">{formatInt(club.leftoverShares)} da oferta + {formatInt(club.lotShares)} do lote do formador</Cell>
      </div>
      <div className="ipo-mine">
        {mine ? (
          <div className="ipo-cells">
            <Cell label="Ações recebidas">{formatInt(mine.shares)}</Cell>
            <Cell label="Valor pago">{formatCents(mine.paid)}</Cell>
            <Cell label="Reserva devolvida">{formatCents(mine.refunded)}</Cell>
          </div>
        ) : (
          <span className="muted small">Você não ofertou neste clube</span>
        )}
      </div>
    </li>
  );
}

/**
 * O resultado do rateio (prancha 3b), depois de todos os clubes liquidados: por clube o preço de corte, a
 * demanda nesse preço, a fração do rateio, o que o jogador recebeu e pagou, a reserva devolvida e o que
 * foi para a tesouraria (a sobra da oferta e o lote do formador). O preço de corte é o preço de referência
 * do clube na abertura da negociação (critério 24).
 */
export function ResultsScreen({ clubs, tradingOpensAt = null }: { clubs: IpoClubResult[]; tradingOpensAt?: string | null }) {
  const mine = clubs.flatMap((c) => (c.myAllocation ? [c.myAllocation] : []));
  const sum = (pick: (a: (typeof mine)[number]) => number) => mine.reduce((total, a) => total + pick(a), 0);
  return (
    <div className="stack" data-testid="resultado">
      <Card title="Resultado do IPO">
        <p className="m0">
          O preço de corte de cada clube é o preço de referência dele na abertura da negociação
          {tradingOpensAt && <>, em <b className="num">{formatInstant(tradingOpensAt)}</b></>}.
        </p>
        {mine.length > 0 && (
          <div className="g-3" style={{ marginTop: 12 }}>
            <div className="kpi" data-testid="resumo-acoes"><span className="kpi-l">Ações recebidas</span><span className="kpi-v">{formatInt(sum((a) => a.shares))}</span></div>
            <div className="kpi" data-testid="resumo-pago"><span className="kpi-l">Total pago</span><span className="kpi-v">{formatCents(sum((a) => a.paid))}</span></div>
            <div className="kpi" data-testid="resumo-devolvido"><span className="kpi-l">Reserva devolvida</span><span className="kpi-v">{formatCents(sum((a) => a.refunded))}</span></div>
          </div>
        )}
      </Card>
      <ul className="ipo-list" aria-label="Resultado por clube">
        {clubs.map((club) => (
          <ResultCard key={club.ticker} club={club} />
        ))}
      </ul>
    </div>
  );
}

/** Enquanto algum clube ainda não foi liquidado: a tela de "liquidando…". */
export function SettlingScreen() {
  return (
    <div className="stack" data-testid="liquidando">
      <Card title="Resultado do IPO">
        <p className="m0" role="status">
          <b>Liquidando…</b> O período de ofertas fechou e o jogo está liquidando o IPO clube a clube. O resultado
          aparece aqui quando todos os clubes estiverem prontos.
        </p>
      </Card>
    </div>
  );
}
