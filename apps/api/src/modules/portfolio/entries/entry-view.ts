import type { EntryGroup, EntryItem } from "@futbolsa/contracts";

/** O grupo de cada tipo de linha do extrato (o filtro do jogador). */
export const ENTRY_GROUP_OF: Record<string, EntryGroup> = {
  initial: "entry",
  index_entry: "entry",
  ipo_reserve: "ipo",
  ipo_settle: "ipo",
  trade: "trade",
  trade_annulled: "trade",
  order_reserve: "other",
  order_release: "other",
  dividend: "dividend",
  reversal: "dividend",
  complement: "dividend",
  adjustment: "adjustment",
  buyback: "buyback",
  season_close: "other",
  account_deleted: "other",
};

export function kindsOfGroup(group: EntryGroup): string[] {
  return Object.entries(ENTRY_GROUP_OF).filter(([, g]) => g === group).map(([k]) => k);
}

/** A linha crua da consulta do extrato (nenhuma coluna de carteira de outra pessoa entra aqui). */
export interface EntryRow {
  id: number;
  at: Date;
  kind: string;
  ticker: string | null;
  club_name: string | null;
  badge_abbr: string | null;
  color_primary: string | null;
  color_secondary: string | null;
  cash_delta: number;
  shares_delta: number;
  price: number | null;
  realized: number | null;
  cash_after: number;
  reason: string | null;
  event_reason: string | null;
  per_share: number | null;
  holding_shares: number | null;
  in_auction: boolean | null;
  /** O negócio desta linha foi anulado pelo admin (F14). */
  annulled: boolean | null;
}

/**
 * De onde vem a linha de dividendo. No crédito, o valor da versão e as ações da foto; no estorno e no complemento, a
 * diferença por ação (o valor lançado dividido pelas ações da foto), e sem ações na foto nova só o motivo da linha.
 */
function payoutOf(r: EntryRow): EntryItem["payout"] {
  if (r.event_reason === null || r.per_share === null) return null;
  const shares = r.holding_shares ?? 0;
  if (r.kind === "reversal" || r.kind === "complement") {
    return shares > 0 ? { reason: r.event_reason, perShare: Math.round(r.cash_delta / shares), shares } : null;
  }
  return { reason: r.event_reason, perShare: r.per_share, shares };
}

/** Monta a linha que o jogador vê. Só campos da própria carteira: nada de contraparte, ordem de outro ou "casa/bot". */
export function entryItemOf(r: EntryRow): EntryItem {
  return {
    id: r.id,
    at: r.at.toISOString(),
    kind: r.kind,
    group: ENTRY_GROUP_OF[r.kind] ?? "other",
    club: r.ticker ? { ticker: r.ticker, name: r.club_name ?? r.ticker, badgeAbbr: r.badge_abbr, colorPrimary: r.color_primary, colorSecondary: r.color_secondary } : null,
    quantity: r.shares_delta,
    price: r.price,
    amount: r.cash_delta,
    realized: r.realized,
    cashAfter: r.cash_after,
    reason: r.reason,
    payout: payoutOf(r),
    inAuction: r.in_auction === true,
    annulled: r.annulled === true,
  };
}
