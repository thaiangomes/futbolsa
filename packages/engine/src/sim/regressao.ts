import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadSeason } from "../data/season.js";
import { BRASILEIRAO_A_2026 as BRASILEIRAO_A, COPA_DO_BRASIL, LIBERTADORES, SULAMERICANA } from "../engine/dividends.js";
import { DEFAULT_MARKET_MAKER } from "../engine/marketMaker.js";
import type { Cents } from "../engine/money.js";
import type { Trade } from "../engine/orderbook.js";
import type { Match } from "../engine/types.js";
import { simulate, type SimConfig, type SimResult } from "./simulate.js";

/**
 * Teste de regressão da simulação: roda cenários fixos e resume cada um numa
 * impressão digital dos negócios (na ordem em que saíram) e do resultado
 * inteiro. Uma refatoração do motor não pode mudar nenhum dos dois.
 * Os caminhos são relativos à pasta do motor (packages/engine).
 */

export interface Fingerprint {
  scenario: string;
  trades: number;
  volume: Cents;
  tradesSha256: string;
  resultSha256: string;
}

export interface Scenario {
  name: string;
  /** Os dois do Brasileirão levam mais de um minuto e ficam fora do `npm test`. */
  slow: boolean;
  run: (onTrade: (t: Trade) => void) => SimResult;
}

/** Dois bots de cada perfil (três traders, um por taxa de acerto): os 9 perfis em poucos segundos. */
const MINI_BOTS: SimConfig["bots"] = {
  dividendos: 2, momentum: 2, torcedor: 4, aleatorio: 2, trader: 3, captura: 2, analista: 2, concentrador: 2, antecipador: 2,
};

/** A mesma configuração do `npm run sim` sem argumentos (os 9 perfis, as três copas, recompra de 1,5×). */
export function defaultRunConfig(seed: number): Partial<SimConfig> {
  const cups = (["libertadores", "copa-do-brasil", "sul-americana"] as const).map((c) => {
    const rules = { libertadores: LIBERTADORES, "copa-do-brasil": COPA_DO_BRASIL, "sul-americana": SULAMERICANA }[c];
    const file = JSON.parse(readFileSync(`data/${c}-2025.json`, "utf8")) as { matches: Match[] };
    return { matches: file.matches, rules };
  });
  return {
    seed,
    bots: { dividendos: 25, momentum: 25, torcedor: 25, aleatorio: 25, trader: 50, captura: 25, analista: 25, concentrador: 25, antecipador: 25 },
    rules: { perPoint: BRASILEIRAO_A.perPoint, placement: [...BRASILEIRAO_A.placement] },
    marketMaker: DEFAULT_MARKET_MAKER,
    buyback: 1.5,
    traderHitRates: [0.3, 0.5, 0.7],
    cups,
    fanCupHype: false,
    ipoCups: true,
    bandWidth: 0.4,
  };
}

export const SCENARIOS: Scenario[] = [
  {
    name: "A-mini-fair",
    slow: false,
    run: (onTrade) => simulate(loadSeason("tests/fixtures/mini-season.json"), { bots: MINI_BOTS, buyback: 1.5, rules: BRASILEIRAO_A }, { onTrade }),
  },
  {
    name: "B-mini-peer",
    slow: false,
    run: (onTrade) =>
      simulate(
        loadSeason("tests/fixtures/mini-season.json"),
        { bots: MINI_BOTS, buyback: 1.5, rules: BRASILEIRAO_A, marketMaker: { ...DEFAULT_MARKET_MAKER, anchor: "peer" } },
        { onTrade },
      ),
  },
  ...[1, 2].map((seed, i) => ({
    name: `${i === 0 ? "C" : "D"}-brasileirao-2025-semente${seed}`,
    slow: true,
    run: (onTrade: (t: Trade) => void) => simulate(loadSeason("data/brasileirao-2025.json"), defaultRunConfig(seed), { onTrade }),
  })),
];

export function fingerprint(name: string, run: (onTrade: (t: Trade) => void) => SimResult): Fingerprint {
  const lines = createHash("sha256");
  let trades = 0;
  let volume = 0;
  const result = run((t) => {
    trades++;
    volume += t.price * t.quantity;
    lines.update(`${t.at};${t.clubId};${t.price};${t.quantity};${t.buyerId};${t.sellerId};${t.aggressor}\n`);
  });
  return {
    scenario: name,
    trades,
    volume,
    tradesSha256: lines.digest("hex"),
    resultSha256: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
  };
}

export const referencePath = (name: string) => `tests/fixtures/regressao/${name}.json`;

export function readReference(name: string): Fingerprint {
  return JSON.parse(readFileSync(referencePath(name), "utf8")) as Fingerprint;
}
