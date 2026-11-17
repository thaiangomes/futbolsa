"use client";

import { useState } from "react";
import { ApiError } from "../../lib/api";
import { MyOrders } from "./my-orders";
import { marketErrorMessage } from "./order-ticket";
import { useMarketApi } from "./club-screen";
import { useMyOrders } from "./use-my-orders";

/**
 * "Minhas ordens" (`/ordens`, critério 60 do livro): as ordens abertas do jogador em todos os clubes, cada uma com Editar
 * e Cancelar. Editar abre o painel com o livro do clube ao vivo (troca atômica, critérios 57 a 59).
 */
export function OrdersScreen() {
  const api = useMarketApi();
  const mine = useMyOrders(api, true);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cancel = async (id: number) => {
    setBusy(id);
    setError(null);
    try {
      await api.cancelOrder(id);
      await mine.reload();
    } catch (e) {
      setError(e instanceof ApiError ? marketErrorMessage(e.code) : "Não foi possível cancelar. Tente de novo.");
    } finally {
      setBusy(null);
    }
  };

  if (mine.orders === null) {
    return mine.error ? (
      <div className="note note-err" role="alert"><div>Não foi possível carregar as suas ordens. Tente de novo em instantes.</div></div>
    ) : (
      <p className="muted">Carregando…</p>
    );
  }
  return <MyOrders orders={mine.orders} onCancel={(id) => void cancel(id)} busyId={busy} error={error} api={api} onChanged={() => void mine.reload()} />;
}
