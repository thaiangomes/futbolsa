"use client";

import { IPO_ERROR_MESSAGES, type IpoOverview } from "@futbolsa/contracts";
import { formatCents, formatInstant, formatInt } from "../../../lib/format";
import type { IpoApi } from "../api";
import { applyBidCancelled, applyBidSaved, biddingOpen, formatCountdown } from "../forms";
import { Card } from "../ui";
import { ClubCard } from "./club-card";

/** O aviso fixo de sigilo: a demanda e as ofertas dos outros só aparecem depois do fechamento (critério 15). */
function SecrecyNote() {
  return (
    <div className="note" data-testid="sigilo">
      <div>
        <b>A demanda fica escondida durante o período de ofertas.</b> Você vê a faixa de cada clube, o tamanho da oferta e as suas próprias
        ofertas; as dos outros jogadores só aparecem, somadas, no resultado, depois do fechamento.
      </div>
    </div>
  );
}

function Schedule({ overview, now, open }: { overview: IpoOverview; now: number; open: boolean }) {
  const remaining = overview.closesAt ? Date.parse(overview.closesAt) - now : null;
  return (
    <Card
      title="Período de ofertas"
      right={
        open && remaining !== null ? (
          <span className="chip chip-live">Fecha em <span data-testid="contagem" className="num">{formatCountdown(remaining)}</span></span>
        ) : undefined
      }
    >
      <div className="g-3 small">
        <div className="kv"><span>Abertura das ofertas</span><span>{formatInstant(overview.opensAt)}</span></div>
        <div className="kv"><span>Fechamento</span><span>{formatInstant(overview.closesAt)}</span></div>
        <div className="kv"><span>Negociação abre</span><span>{formatInstant(overview.tradingOpensAt)}</span></div>
      </div>
      {overview.offerSize !== null && (
        <p className="m0" style={{ marginTop: 8 }}>
          Oferta: <b className="num">{formatInt(overview.offerSize)} ações por clube</b>
        </p>
      )}
    </Card>
  );
}

function CashSummary({ cash }: { cash: NonNullable<IpoOverview["cash"]> }) {
  return (
    <div className="card">
      <div className="card-b g-3">
        <div className="kpi" data-testid="caixa-total"><span className="kpi-l">Caixa total</span><span className="kpi-v">{formatCents(cash.total)}</span></div>
        <div className="kpi" data-testid="caixa-reservado"><span className="kpi-l">Reservado nas ofertas</span><span className="kpi-v">{formatCents(cash.reserved)}</span></div>
        <div className="kpi" data-testid="caixa-livre"><span className="kpi-l">Livre</span><span className="kpi-v">{formatCents(cash.free)}</span></div>
      </div>
    </div>
  );
}

/**
 * O período de ofertas (prancha 3). Antes da abertura, só a data em que abre e nenhuma faixa. Aberto, as
 * faixas, as ofertas do jogador e o caixa; depois do horário de fechamento (mesmo com a tarefa atrasada),
 * só leitura. O estado vive na página: aqui só se mostra e se manda para a API.
 */
export function OfferPeriod({ overview, api, now, onOverview, onStale }: {
  overview: IpoOverview;
  api: IpoApi;
  /** O relógio (ms) para a contagem e para saber se ainda dá para ofertar. */
  now: number;
  onOverview(update: (current: IpoOverview) => IpoOverview): void;
  onStale(): void;
}) {
  if (overview.status === "preparing") {
    return (
      <div className="stack" data-testid="periodo">
        <Card title="Período de ofertas">
          {overview.opensAt ? (
            <p className="m0">
              As ofertas abrem em <b className="num">{formatInstant(overview.opensAt)}</b> (horário de Brasília).
              {overview.closesAt && <> Elas fecham em <b className="num">{formatInstant(overview.closesAt)}</b>.</>}
            </p>
          ) : (
            <p className="m0">A data de abertura das ofertas ainda não foi definida.</p>
          )}
        </Card>
        <SecrecyNote />
      </div>
    );
  }

  const open = biddingOpen(overview, now);
  return (
    <div className="stack" data-testid="periodo">
      <Schedule overview={overview} now={now} open={open} />
      {overview.cash ? (
        <CashSummary cash={overview.cash} />
      ) : (
        <div className="note note-live" role="status"><div>{IPO_ERROR_MESSAGES.no_wallet}</div></div>
      )}
      {!open && (
        <div className="note note-live" role="status"><div>{IPO_ERROR_MESSAGES.ipo_closed}</div></div>
      )}
      <SecrecyNote />
      <ul className="ipo-list" aria-label="Clubes do IPO">
        {overview.clubs.map((club) => (
          <ClubCard
            key={club.ticker}
            club={club}
            cash={overview.cash}
            canBid={open}
            api={api}
            onSaved={(ticker, r) => onOverview((o) => applyBidSaved(o, ticker, r.bid, r.cash))}
            onCancelled={(ticker, r) => onOverview((o) => applyBidCancelled(o, ticker, r.cash))}
            onStale={onStale}
          />
        ))}
      </ul>
    </div>
  );
}
