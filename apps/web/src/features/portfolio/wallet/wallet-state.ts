import type { AuctionState, EntriesQuery, EntryGroup, PriceEvent, WalletView } from "@futbolsa/contracts";

/**
 * O que o `price` do canal `prices` muda na carteira sem pedir nada: o aviso de leilão da posição (T23). O preço e as
 * contas que dependem dele (valor a mercado, patrimônio) voltam do servidor: o site não faz conta de dinheiro.
 */
export function applyPriceToWallet(view: WalletView, event: PriceEvent): WalletView {
  const index = view.positions.findIndex((p) => p.club.ticker === event.ticker);
  if (index < 0) return view;
  const current = view.positions[index]!;
  if (sameAuction(current.auction, event.auction)) return view;
  const positions = view.positions.slice();
  positions[index] = { ...current, auction: event.auction };
  return { ...view, positions };
}

function sameAuction(a: AuctionState | null, b: AuctionState | null): boolean {
  if (a === null || b === null) return a === b;
  return a.until === b.until;
}

/** O `price` mudou o preço de um clube que o jogador tem (a carteira relê para recalcular o valor). */
export function priceChangesHeldClub(view: WalletView, event: PriceEvent): boolean {
  const position = view.positions.find((p) => p.club.ticker === event.ticker);
  return position !== undefined && position.price !== event.price;
}

/** O filtro do extrato: clube e grupo de tipo (ambos opcionais). */
export interface EntryFilter {
  club?: string;
  kind?: EntryGroup;
}

export function entryQuery(filter: EntryFilter, before?: string): Partial<EntriesQuery> {
  return { club: filter.club, kind: filter.kind, before, limit: 30 };
}

export const ENTRY_GROUP_LABELS: Record<EntryGroup, string> = {
  entry: "Entrada",
  ipo: "IPO",
  trade: "Negócios",
  dividend: "Dividendos",
  buyback: "Recompra",
  adjustment: "Ajustes",
  other: "Outros",
};

export const ENTRY_KIND_LABELS: Record<string, string> = {
  initial: "Entrada na temporada",
  index_entry: "Carteira índice",
  ipo_settle: "IPO: ações recebidas",
  ipo_reserve: "IPO: reserva",
  trade: "Negócio",
  trade_annulled: "Negócio anulado pelo admin",
  dividend: "Dividendo",
  reversal: "Estorno",
  complement: "Complemento",
  adjustment: "Ajuste",
  buyback: "Recompra",
  season_close: "Encerramento",
  account_deleted: "Conta excluída",
  order_reserve: "Reserva de ordem",
  order_release: "Reserva devolvida",
};
