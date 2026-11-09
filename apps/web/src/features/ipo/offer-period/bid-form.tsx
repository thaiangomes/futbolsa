"use client";

import { IPO_ERROR_MESSAGES, type IpoClubView, type PutBidBody } from "@futbolsa/contracts";
import { type FormEvent, useState } from "react";
import { formatCents } from "../../../lib/format";
import { bidPreview, reaisField } from "../forms";

/**
 * Quantidade e preço máximo (em reais; a API recebe centavos) com a prévia da reserva: quantidade ×
 * o menor valor entre o preço máximo e o teto. A prévia usa a mesma conta do motor; o que a API
 * recusa (piso, caixa, estado do IPO) volta pela mensagem do código, no cartão do clube.
 */
export function BidForm({ club, freeCash, busy, onSubmit, onClose }: {
  club: IpoClubView;
  freeCash: number;
  busy: boolean;
  onSubmit(body: PutBidBody): void;
  onClose(): void;
}) {
  const { ticker, band, myBid } = club;
  const [quantity, setQuantity] = useState(myBid ? String(myBid.quantity) : "");
  const [price, setPrice] = useState(myBid ? reaisField(myBid.maxPrice) : "");
  const preview = bidPreview({ quantity, maxPrice: price, band, freeCash, currentReserve: myBid?.reserved ?? 0 });
  const isEdit = myBid !== null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!preview.ok || busy) return;
    onSubmit({ quantity: preview.quantity, maxPrice: preview.maxPrice, expect: isEdit ? "existing" : "new" });
  };

  return (
    <form className="ipo-form" onSubmit={submit} aria-label={`Oferta de ${ticker}`}>
      <div className="field">
        <label htmlFor={`qtd-${ticker}`}>Quantidade de ações</label>
        <input id={`qtd-${ticker}`} className={`input ipo-touch${!preview.ok && preview.quantityError ? " err" : ""}`} inputMode="numeric" autoComplete="off" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        {!preview.ok && preview.quantityError && <span className="hint err">{preview.quantityError}</span>}
      </div>
      <div className="field">
        <label htmlFor={`preco-${ticker}`}>Preço máximo (R$)</label>
        <input id={`preco-${ticker}`} className={`input ipo-touch${!preview.ok && preview.priceError ? " err" : ""}`} inputMode="decimal" autoComplete="off" value={price} onChange={(e) => setPrice(e.target.value)} />
        {!preview.ok && preview.priceError && <span className="hint err">{preview.priceError}</span>}
      </div>
      <div className="ipo-preview" aria-live="polite">
        <div className="kv">
          <span>Reserva</span>
          <span data-testid={`reserva-${ticker}`}>{preview.ok ? formatCents(preview.reserve) : "—"}</span>
        </div>
        {preview.ok && (
          <>
            <div className="hint">
              {preview.quantity.toLocaleString("pt-BR")} × {formatCents(preview.effectivePrice)} (o menor entre o seu preço máximo e o teto de {formatCents(band.ceiling)}).
            </div>
            {preview.aboveCeiling && (
              <div className="hint" data-testid={`acima-do-teto-${ticker}`}>
                Seu preço máximo passa do teto: a oferta vale como {formatCents(band.ceiling)}.
              </div>
            )}
            {preview.belowFloor && <div className="hint err">{IPO_ERROR_MESSAGES.below_band_floor}</div>}
            {preview.freeAfter < 0 ? (
              <div className="hint err">{IPO_ERROR_MESSAGES.insufficient_cash}</div>
            ) : (
              <div className="hint" data-testid={`livre-depois-${ticker}`}>Caixa livre depois da oferta: {formatCents(preview.freeAfter)}</div>
            )}
          </>
        )}
      </div>
      <div className="ipo-form-actions">
        <button type="submit" className="btn btn-p ipo-touch" disabled={!preview.ok || busy}>
          {isEdit ? "Salvar alteração" : "Registrar oferta"}
        </button>
        <button type="button" className="btn btn-ghost ipo-touch" onClick={onClose} disabled={busy}>Fechar</button>
      </div>
    </form>
  );
}
