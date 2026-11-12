import type { EntryGroup, EntryItem } from "@futbolsa/contracts";

/** O grupo de cada tipo de linha do extrato (o filtro do jogador). */
export const ENTRY_GROUP_OF: Record<string, EntryGroup> = {
  initial: "entry",
  index_entry: "entry",
  ipo_reserve: "ipo",
  ipo_settle: "ipo",
  trade: "trade",
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
    payout: r.event_reason !== null && r.per_share !== null ? { reason: r.event_reason, perShare: r.per_share, shares: r.holding_shares ?? 0 } : null,
    inAuction: r.in_auction === true,
  };
}
