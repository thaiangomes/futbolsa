import { z } from "zod";

/** Ticker de um clube: três letras maiúsculas e um número (`FLA3`). A lista de clubes da temporada não entra aqui. */
export const TICKER_PATTERN = /^[A-Z]{3}[0-9]$/;

/** Canais sem parâmetro. `me` e `admin` são privados; os outros são públicos. */
export const FIXED_CHANNELS = ["season", "prices", "rankings", "me", "admin"] as const;

export type FixedChannel = (typeof FIXED_CHANNELS)[number];
export type ClubChannel = `club:${string}`;
export type Channel = FixedChannel | ClubChannel;

/** O tipo de canal, sem o ticker: é o que o catálogo de eventos e as regras de acesso usam. */
export type ChannelKind = FixedChannel | "club";

/** Tipos de canal que qualquer conexão pode assinar, sem login. */
export const PUBLIC_CHANNEL_KINDS: readonly ChannelKind[] = ["season", "prices", "rankings", "club"];

export function clubChannel(ticker: string): ClubChannel {
  return `club:${ticker}`;
}

/** Devolve o canal se o texto for um canal válido, ou `null`. `club:fla3`, `club:` e `club:FLA3:x` não são. */
export function parseChannel(value: string): Channel | null {
  if ((FIXED_CHANNELS as readonly string[]).includes(value)) return value as FixedChannel;
  if (value.startsWith("club:") && TICKER_PATTERN.test(value.slice(5))) return value as ClubChannel;
  return null;
}

export function channelKind(channel: Channel): ChannelKind {
  return channel.startsWith("club:") ? "club" : (channel as FixedChannel);
}

export const channelSchema = z.string().refine((value): value is Channel => parseChannel(value) !== null, {
  message: "canal inválido",
});
