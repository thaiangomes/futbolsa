import {
  type BookView,
  type EventEnvelope,
  type PublicTrade,
  RECENT_TRADES,
  bookEventSchema,
  matchModeEventSchema,
  tradeEventSchema,
} from "@futbolsa/contracts";

/**
 * O estado da tela de um clube (livro, últimos negócios, preço, modo de jogo e leilão): é o `BookView` de
 * `GET /clubs/:ticker/book` com os eventos do canal `club:<ticker>` aplicados por cima, pelo `SyncedChannel` da F6.
 * Cada evento leva o valor absoluto (ou um negócio com `id`), então aplicar duas vezes dá o mesmo estado.
 */
export type ClubState = BookView;

/**
 * Variação em centésimos de ponto percentual (+5,00% = 500), arredondada para o mais perto, a metade para longe do
 * zero: a mesma conta da API (`changeBp` do `market`), para o preço da tela não divergir do da rota.
 */
export function changeBpOf(current: number, reference: number): number {
  if (reference <= 0) return 0;
  const diff = current - reference;
  const magnitude = Math.floor((Math.abs(diff) * 10_000 * 2 + reference) / (reference * 2));
  return diff < 0 ? -magnitude : magnitude;
}

/** Junta negócios novos à lista: sem repetir pelo `id`, do mais novo para o mais antigo, no máximo 20. */
export function mergeTrades(current: readonly PublicTrade[], incoming: readonly PublicTrade[]): PublicTrade[] {
  const byId = new Map<number, PublicTrade>();
  for (const t of [...current, ...incoming]) byId.set(t.id, t);
  return [...byId.values()].sort((a, b) => b.id - a.id).slice(0, RECENT_TRADES);
}

/** Aplica um evento do canal do clube. Evento de outro tipo ou fora do esquema deixa o estado como estava. */
export function applyClubEvent(state: ClubState, event: EventEnvelope): ClubState {
  switch (event.type) {
    case "trade": {
      const parsed = tradeEventSchema.safeParse(event.data);
      if (!parsed.success) return state;
      const trades = mergeTrades(state.trades, [parsed.data]);
      // o preço exibido é o do negócio mais novo; um negócio atrasado (id menor) não volta o preço atrás
      const newest = trades[0]!;
      const displayed = newest.price;
      return { ...state, trades, price: { ...state.price, displayed, changeBp: changeBpOf(displayed, state.price.open) } };
    }
    case "book": {
      const parsed = bookEventSchema.safeParse(event.data);
      if (!parsed.success) return state;
      return { ...state, bids: parsed.data.bids, asks: parsed.data.asks, auction: parsed.data.auction };
    }
    case "match_mode": {
      const parsed = matchModeEventSchema.safeParse(event.data);
      if (!parsed.success) return state;
      return { ...state, matchMode: parsed.data.active };
    }
    default:
      return state;
  }
}
