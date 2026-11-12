import type { GameMarker, MyTrade, PayoutMarker } from "@futbolsa/contracts";
import { candleStart } from "@futbolsa/engine/engine/candles";
import { formatMoney, formatShares } from "../format";
import { formatChartDateTime } from "../format";
import { gameContext, payoutKindLabel, resultText, scoreLine } from "./labels";

export type MarkerTone = "up" | "down" | "neutral" | "amber" | "dividend";

/** Um marcador do gráfico (círculo, quadrado ou seta), já posicionado no candle e com o texto do balão. */
export interface ChartMarker {
  id: string;
  /** Início do candle que o contém, em segundos. */
  time: number;
  position: "aboveBar" | "belowBar";
  shape: "arrowUp" | "arrowDown" | "circle" | "square";
  tone: MarkerTone;
  /** O texto curto ao lado da forma. */
  text: string;
  /** O balão ao clicar. */
  title: string;
  lines: string[];
  /** A categoria, para a lista textual. */
  kind: "game" | "payout" | "trade";
}

export interface AggregatedTrade {
  time: number;
  side: "buy" | "sell";
  quantity: number;
  /** Preço médio ponderado pela quantidade, em centavos (arredondado para o mais perto). */
  price: number;
  /** Quantos negócios entraram. */
  count: number;
}

const snap = (interval: "15m" | "1d", iso: string) => Math.floor(candleStart(interval, Date.parse(iso)) / 1000);

/** Junta os negócios que caem no mesmo candle e lado: quantidade somada e preço médio ponderado. Do mais antigo para o mais novo. */
export function aggregateTrades(trades: readonly MyTrade[], interval: "15m" | "1d"): AggregatedTrade[] {
  const groups = new Map<string, { time: number; side: "buy" | "sell"; quantity: number; notional: number; count: number }>();
  for (const t of trades) {
    const time = snap(interval, t.at);
    const key = `${time}:${t.side}`;
    const g = groups.get(key) ?? { time, side: t.side, quantity: 0, notional: 0, count: 0 };
    g.quantity += t.quantity;
    g.notional += t.quantity * t.price;
    g.count += 1;
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => ({ time: g.time, side: g.side, quantity: g.quantity, price: Math.round(g.notional / g.quantity), count: g.count }))
    .sort((a, b) => a.time - b.time || a.side.localeCompare(b.side));
}

export interface MarkerInput {
  ticker: string;
  interval: "15m" | "1d";
  /** O início do primeiro e do último candle da série, em segundos: marcadores fora da janela não aparecem. */
  window: { from: number; to: number };
  games: readonly GameMarker[];
  payouts: readonly PayoutMarker[];
  trades: readonly MyTrade[];
}

function tone(result: GameMarker["result"]): MarkerTone {
  return result === "V" ? "up" : result === "D" ? "down" : "neutral";
}

/** Todos os marcadores do gráfico, ordenados por tempo. */
export function buildMarkers({ ticker, interval, window, games, payouts, trades }: MarkerInput): ChartMarker[] {
  const out: ChartMarker[] = [];
  const inside = (time: number) => time >= window.from && time <= window.to;

  games.forEach((g, i) => {
    const time = snap(interval, g.at);
    if (!inside(time)) return;
    const live = g.status === "live";
    out.push({
      id: `game-${i}`,
      time,
      position: "aboveBar",
      shape: "circle",
      tone: live ? "amber" : tone(g.result),
      text: live ? "●" : (g.result ?? ""),
      title: gameContext(g),
      lines: [`${scoreLine(ticker, g)}${live ? "" : ` · ${resultText(g)}`}`, live ? "Em andamento" : formatChartDateTime(Date.parse(g.at) / 1000)],
      kind: "game",
    });
  });

  payouts.forEach((p, i) => {
    const time = snap(interval, p.at);
    if (!inside(time)) return;
    const perShare = formatMoney(p.perShare);
    out.push({
      id: `payout-${i}`,
      time,
      position: "belowBar",
      shape: "square",
      tone: "dividend",
      text: p.kind === "payout" ? perShare : `${p.kind === "reversal" ? "estorno" : "compl."} ${perShare}`,
      title: payoutKindLabel(p),
      lines: [`${perShare} por ação`, p.reason, ...(p.status === "pending" ? ["Aguardando aprovação: o valor pode mudar numa correção"] : [])],
      kind: "payout",
    });
  });

  aggregateTrades(trades, interval).forEach((t, i) => {
    if (!inside(t.time)) return;
    const buy = t.side === "buy";
    out.push({
      id: `trade-${i}`,
      time: t.time,
      position: buy ? "belowBar" : "aboveBar",
      shape: buy ? "arrowUp" : "arrowDown",
      tone: "amber",
      text: `${buy ? "C" : "V"} ${formatShares(t.quantity)}`,
      title: buy ? "Minha compra" : "Minha venda",
      lines: [`${formatShares(t.quantity)} ações a ${formatMoney(t.price)}${t.count > 1 ? ` (preço médio de ${t.count} negócios)` : ""}`, formatChartDateTime(t.time)],
      kind: "trade",
    });
  });

  return out.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
}
