"use client";

import { type ClubList, type EventEnvelope, type PriceEvent, priceEventSchema } from "@futbolsa/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useChannel } from "../../realtime/react";
import { formatCents } from "../../lib/format";
import type { MarketApi } from "./api";
import { auctionNotice, changeClass, formatChange } from "./format";

/** Aplica um evento `price` (valor absoluto) ao clube da lista. Evento de clube desconhecido não muda nada. */
export function applyPriceToList(list: ClubList, event: PriceEvent): ClubList {
  if (!list.clubs.some((c) => c.ticker === event.ticker)) return list;
  return {
    ...list,
    clubs: list.clubs.map((c) => (c.ticker === event.ticker ? { ...c, price: event.price, changeBp: event.changeBp, auction: event.auction } : c)),
  };
}

const REFRESH_MS = 60_000;

/**
 * A lista dos clubes lida de `GET /clubs` e mantida pelo canal `prices` (no máximo um `price` por clube por segundo).
 * O `seq` da resposta vem lido antes do banco: um `price` com `seq` menor ou igual já estava nela. O modo de jogo e a
 * suspensão não vão no `price`, então a lista relê quando o canal `season` avisa uma suspensão ou retomada e a cada
 * minuto.
 */
export function useClubList(api: MarketApi): { list: ClubList | null; error: boolean } {
  const [list, setList] = useState<ClubList | null>(null);
  const [error, setError] = useState(false);
  const pending = useRef(new Map<string, { seq: number; data: PriceEvent }>());
  const alive = useRef(true);
  const apiRef = useRef(api);
  apiRef.current = api;

  const load = useCallback(async () => {
    try {
      const fresh = await apiRef.current.clubs();
      if (!alive.current) return;
      let next = fresh;
      for (const { seq, data } of pending.current.values()) if (seq > fresh.seq) next = applyPriceToList(next, data);
      setList(next);
      setError(false);
    } catch {
      if (alive.current) setError(true);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [load]);

  useChannel("prices", {
    onEvent: (event: EventEnvelope) => {
      if (event.type !== "price") return;
      const parsed = priceEventSchema.safeParse(event.data);
      if (!parsed.success) return;
      pending.current.set(parsed.data.ticker, { seq: event.seq, data: parsed.data });
      setList((current) => (current ? applyPriceToList(current, parsed.data) : current));
    },
    onSubscribed: ({ mode }) => {
      if (mode === "resync") void load();
    },
  });
  useChannel("season", {
    onEvent: (event) => {
      if (event.type === "market.suspended" || event.type === "market.resumed" || event.type === "season.status") void load();
    },
  });

  return { list, error };
}

/**
 * A lista de clubes (`/mercado`, decisão D6 do plano): ticker, nome, preço, variação do dia e os avisos "em jogo agora",
 * "em leilão até 15h40" e "suspenso", com link para a tela do clube.
 */
export function ClubList({ api }: { api: MarketApi }) {
  const { list, error } = useClubList(api);
  if (!list) {
    return error ? (
      <div className="note note-err" role="alert"><div>Não foi possível carregar os clubes. Tente de novo em instantes.</div></div>
    ) : (
      <p className="muted">Carregando…</p>
    );
  }
  return (
    <section className="card" aria-labelledby="t-clubes">
      <div className="card-h">
        <h2 className="card-t" id="t-clubes">Clubes</h2>
        <span className="xs muted">{list.clubs.length} listados</span>
      </div>
      {list.market.state === "not_open" && (
        <div className="note" role="status" data-testid="mercado-fechado"><div>A negociação ainda não abriu.</div></div>
      )}
      <div className="scroll-x">
        <table className="tbl">
          <thead>
            <tr><th>Clube</th><th className="r">Preço</th><th className="r">Variação</th><th>Estado</th></tr>
          </thead>
          <tbody>
            {list.clubs.map((c) => (
              <tr key={c.ticker} data-testid="clube" data-ticker={c.ticker}>
                <td>
                  <a href={`/clube?t=${c.ticker}`} className="b" data-testid="link-clube">{c.ticker}</a>
                  <span className="xs muted"> {c.name}</span>
                </td>
                <td className="r b num">{formatCents(c.price)}</td>
                <td className={`r ${changeClass(c.changeBp)} num`}>{formatChange(c.changeBp)}</td>
                <td>
                  {c.suspended && <span className="chip chip-down" title={c.suspended.reason}>Suspenso</span>}
                  {!c.suspended && c.auction && <span className="chip chip-live" data-testid="estado-leilao"><span className="dot-live" />{auctionNotice(c.auction)}</span>}
                  {!c.suspended && c.matchMode && <span className="chip chip-live" data-testid="estado-jogo"><span className="dot-live" />Em jogo agora</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
