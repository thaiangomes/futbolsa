"use client";

import type { IpoCash, IpoClubView } from "@futbolsa/contracts";
import { useState } from "react";
import { formatCents, formatInt } from "../../../lib/format";
import type { IpoApi } from "../api";
import { STALE_CODES } from "../forms";
import { ApiError } from "../../../lib/api";
import { Cell, ErrorNote, useAction } from "../ui";
import { ClubBadgeMark } from "../../portfolio/club-badge";
import { BidForm } from "./bid-form";

/**
 * Um clube no período de ofertas: a faixa com a conta (preço da colocação + copas esperadas = centro),
 * a oferta do próprio jogador e, só com o IPO aberto, os botões de ofertar, editar e cancelar.
 * Nunca mostra nada das ofertas dos outros.
 */
export function ClubCard({ club, cash, canBid, api, onSaved, onCancelled, onStale }: {
  club: IpoClubView;
  /** `null` = sem carteira na temporada (não dá para ofertar). */
  cash: IpoCash | null;
  canBid: boolean;
  api: IpoApi;
  onSaved(ticker: string, result: Awaited<ReturnType<IpoApi["putBid"]>>): void;
  onCancelled(ticker: string, result: Awaited<ReturnType<IpoApi["deleteBid"]>>): void;
  /** A API disse que o estado mudou (fechou, oferta já existe...): a tela relê. */
  onStale(): void;
}) {
  const { ticker, name, band, myBid } = club;
  const [editing, setEditing] = useState(false);
  const action = useAction();
  const interactive = canBid && cash !== null;
  const staleOnError = (e: unknown) => {
    if (e instanceof ApiError && STALE_CODES.includes(e.code)) onStale();
  };

  return (
    <li className="ipo-card" data-ticker={ticker}>
      <div className="ipo-id">
        <ClubBadgeMark club={{ ticker, name }} size={30} />
        <span className="chip">{ticker}</span>
        <b>{name}</b>
      </div>

      <div className="ipo-band">
        <div className="ipo-cells">
          <Cell label="Piso">{formatCents(band.floor)}</Cell>
          <Cell label="Centro">{formatCents(band.center)}</Cell>
          <Cell label="Teto">{formatCents(band.ceiling)}</Cell>
        </div>
        <p className="ipo-conta xs muted">
          Colocação do ano anterior {formatCents(band.placementPrice)} + copas esperadas {formatCents(band.cupsPart)} = centro {formatCents(band.center)}
        </p>
      </div>

      <div className="ipo-mine">
        {myBid ? (
          <div className="ipo-cells">
            <Cell label="Sua quantidade">{formatInt(myBid.quantity)}</Cell>
            <Cell label="Preço máximo">{formatCents(myBid.maxPrice)}</Cell>
            <Cell label="Reservado">{formatCents(myBid.reserved)}</Cell>
          </div>
        ) : (
          <span className="muted small">Sem oferta neste clube</span>
        )}
      </div>

      {interactive && (
        <div className="ipo-actions">
          {!editing && (
            <button type="button" className="btn btn-p ipo-touch" onClick={() => setEditing(true)}>
              {myBid ? "Editar" : "Ofertar"}
            </button>
          )}
          {myBid && (
            <button
              type="button"
              className="btn btn-danger ipo-touch"
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  const result = await api.deleteBid(ticker);
                  setEditing(false);
                  onCancelled(ticker, result);
                }, staleOnError)
              }
            >
              Cancelar oferta
            </button>
          )}
        </div>
      )}

      {interactive && editing && (
        <BidForm
          club={club}
          freeCash={cash.free}
          busy={action.busy}
          onClose={() => {
            setEditing(false);
            action.clearError();
          }}
          onSubmit={(body) =>
            void action.run(async () => {
              const result = await api.putBid(ticker, body);
              setEditing(false);
              onSaved(ticker, result);
            }, staleOnError)
          }
        />
      )}
      <ErrorNote message={action.error} />
    </li>
  );
}
