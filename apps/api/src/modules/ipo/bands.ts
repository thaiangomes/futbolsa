import { cupExpected, type Cents, type IpoBand, ipoBand, prepareCups, type SeasonValues } from "@futbolsa/engine";
import { CUP_COMPETITIONS } from "../../infra/db/schema/values.js";
import { type MatchRow, toEngineMatch } from "../admin/results/to-engine.js";

/** Um clube listado na temporada, como a abertura do IPO o lê de `season_clubs`. */
export interface ListedClub {
  clubId: number;
  ticker: string;
  division: string;
  /** 1 a 20 pela Série A anterior, 21 a 24 os promovidos, `null` o Clube dos Treze na Série B. */
  prevPlacement: number | null;
}

/**
 * A lista de clubes vale para abrir o IPO pela mesma regra que o `PUT /admin/seasons/:id/clubs` da F7
 * aplica: 20 clubes na Série A, cada um com a colocação anterior de 1 a 24, sem repetir, e os da Série B
 * (Clube dos Treze) sem colocação. Conferida de novo aqui porque a abertura não confia no caminho que a
 * lista fez até o banco.
 */
export function clubsListValid(listed: readonly ListedClub[]): boolean {
  const inA = listed.filter((c) => c.division === "A");
  const placements = listed.map((c) => c.prevPlacement).filter((p): p is number => p !== null);
  return (
    inA.length === 20 &&
    inA.every((c) => c.prevPlacement !== null && Number.isInteger(c.prevPlacement) && c.prevPlacement >= 1 && c.prevPlacement <= 24) &&
    listed.every((c) => c.division === "A" || (c.division === "B" && c.prevPlacement === null)) &&
    new Set(placements).size === placements.length
  );
}

/**
 * Copas esperadas de cada clube listado na data do fechamento (IPO por bookbuilding, "Copas
 * esperadas"): os jogos das três copas que o `admin` tem agora, no formato do motor, com as regras da
 * temporada (`loadSeasonValues`). Clube não listado vira `EXT-<id>`, como no resto da API. Jogo de copa
 * sem fase fica de fora: o motor agrupa os jogos pela fase.
 */
export function cupsExpectedAt(
  listed: readonly ListedClub[],
  cupMatches: readonly MatchRow[],
  values: SeasonValues,
  atMs: number,
): Map<string, Cents> {
  const tickers = new Map(listed.map((c) => [c.clubId, c.ticker]));
  const tickerOf = (clubId: number) => tickers.get(clubId) ?? `EXT-${clubId}`;
  const prepared = prepareCups(
    CUP_COMPETITIONS.filter((competition) => values.cups[competition]).map((competition) => ({
      rules: values.cups[competition]!,
      matches: cupMatches
        .filter((m) => m.competition === competition && m.phase !== null)
        .map((m) => toEngineMatch(m, tickerOf)),
    })),
  );
  return new Map(listed.map((c) => [c.ticker, cupExpected(c.ticker, atMs, prepared)]));
}

/**
 * A faixa de cada clube listado, calculada na abertura das ofertas e fixa até o fechamento (proposta 1
 * do Plano do IPO): centro = preço da colocação + copas esperadas no fechamento × (1 + múltiplo da
 * recompra), piso e teto ±40%. Um jogo de copa decidido durante o período não muda a faixa, porque o
 * teto define a reserva de quem já ofertou.
 */
export function ipoBands(
  listed: readonly ListedClub[],
  cupMatches: readonly MatchRow[],
  values: SeasonValues,
  buybackBp: number,
  closesAtMs: number,
): Map<number, IpoBand> {
  const cups = cupsExpectedAt(listed, cupMatches, values, closesAtMs);
  return new Map(
    listed.map((c) => [c.clubId, ipoBand({ placement: c.prevPlacement, cupExpected: cups.get(c.ticker)!, buybackBp })]),
  );
}
