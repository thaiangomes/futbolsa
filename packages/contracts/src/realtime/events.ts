import { channelKind, type Channel, type ChannelKind } from "./channels.js";

/**
 * O catálogo: a que tipo de canal cada evento do jogo pertence. Os módulos donos (F8 em
 * diante) acrescentam aqui os eventos novos; o conteúdo (`data`) é deles.
 */
export const EVENT_CATALOG = {
  "season.status": "season",
  "market.suspended": "season",
  "market.resumed": "season",
  price: "prices",
  trade: "club",
  book: "club",
  match_mode: "club",
  candle: "club",
  "order.updated": "me",
  "wallet.changed": "me",
  "entry.added": "me",
  "payout.credited": "me",
  "rankings.live": "rankings",
  "admin.pending": "admin",
} as const satisfies Record<string, ChannelKind>;

export type EventType = keyof typeof EVENT_CATALOG;

export function isEventType(value: string): value is EventType {
  return Object.hasOwn(EVENT_CATALOG, value);
}

/** O tipo de canal onde o evento pode ser publicado. */
export function channelKindOfEvent(type: EventType): ChannelKind {
  return EVENT_CATALOG[type];
}

/** `true` se o evento pertence ao canal (`trade` em `club:FLA3`, mas não em `prices`). */
export function channelAcceptsEvent(channel: Channel, type: string): type is EventType {
  return isEventType(type) && EVENT_CATALOG[type] === channelKind(channel);
}
