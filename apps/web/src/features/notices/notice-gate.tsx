"use client";

import { useState } from "react";
import { readNoticeResponseSchema, type PendingNotice } from "@futbolsa/contracts";
import { ApiError } from "../../lib/api";
import { formatCents, formatInstant } from "../../lib/format";
import { Footer, SimpleHeader } from "../accounts/ui/brand";
import { useSession } from "../accounts/session-provider";

/**
 * O aviso do admin ao jogador (F14, T30): aparece **antes de qualquer tela**, até o jogador confirmar que leu. Mostra os
 * negócios anulados, o motivo e o que acontece se continuar. Nunca cita a outra conta. A API não recusa ordem por
 * aviso pendente (proposta 23): a tela é o aviso.
 */
export function NoticeGate({ notice }: { notice: PendingNotice }) {
  const { api, reload } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ban = notice.kind === "fraud_ban";

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await api.request(readNoticeResponseSchema, `/me/notices/${notice.id}/read`, { method: "POST" });
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Não deu para confirmar agora. Tente de novo.");
      setBusy(false);
    }
  }

  return (
    <>
      <SimpleHeader />
      <main className="wrap stack" style={{ gap: 24, maxWidth: 720, paddingTop: 32, paddingBottom: 48 }} aria-labelledby="aviso-titulo">
        <div className="stack-s" style={{ gap: 6 }}>
          <h1 className="h1" id="aviso-titulo">
            {ban ? "Sua conta foi bloqueada" : "Negócios anulados na sua conta"}
          </h1>
          <p className="muted m0">
            {ban
              ? "O admin bloqueou a sua conta por trapaça."
              : "O admin anulou negócios da sua conta por trapaça: negócios combinados para mexer no preço de um clube. As ações e o dinheiro deles foram devolvidos."}
          </p>
        </div>
        <section className="card card-b stack-s" aria-label="Motivo">
          <span className="xs muted">Motivo</span>
          <p className="m0">{notice.body.reason}</p>
        </section>
        {notice.body.trades.length > 0 && (
          <section className="card card-b stack-s" aria-label="Negócios anulados">
            <h2 className="h3">Negócios anulados</h2>
            <ul className="stack-s m0" style={{ paddingLeft: 18, gap: 6 }}>
              {notice.body.trades.map((t, i) => (
                <li key={`${t.at}-${i}`} className="small">
                  {formatInstant(t.at)} · <strong>{t.ticker}</strong> · {t.quantity} {t.quantity === 1 ? "ação" : "ações"} a {formatCents(t.price)} ({formatCents(t.value)})
                </li>
              ))}
            </ul>
          </section>
        )}
        {!ban && <div className="note note-live"><div>Se você continuar trapaceando, a sua conta será banida.</div></div>}
        {error && <div className="note note-err" role="alert"><div>{error}</div></div>}
        <div className="row">
          <button type="button" className="btn btn-p btn-lg" disabled={busy} onClick={() => void confirm()}>
            Li e entendi
          </button>
        </div>
      </main>
      <Footer />
    </>
  );
}
