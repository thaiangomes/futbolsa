import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, ne, sql } from "drizzle-orm";
import { bots, clubs, payoutEvents, positions, seasonClubs, trades, wallets } from "../src/infra/db/schema/index.js";
import type { Carregado } from "./carregar.js";
import type { ServidorEnsaio } from "./servidor.js";
import { loadSeason } from "../../../packages/engine/src/data/season.js";
import { BRASILEIRAO_A, COPA_DO_BRASIL, LIBERTADORES, SULAMERICANA } from "../../../packages/engine/src/engine/dividends.js";
import { simulate } from "../../../packages/engine/src/sim/simulate.js";
import type { Match } from "../../../packages/engine/src/engine/types.js";

/**
 * Comparação do ensaio com a simulação (T9, P5 e P12 do Plano do ensaio).
 * - **Exatas** (não dependem do sorteio dos bots): faixa do IPO de cada clube e dividendos e recompra por ação de cada clube.
 *   A referência é a própria `simulate()` com as regras do jogo e 1 bot por perfil: essas medidas saem só dos resultados e das tabelas.
 * - **Por faixa** (dependem dos bots): preço final ÷ preço do IPO, negócios por bot e retorno médio por perfil, dentro de
 *   [mínimo, máximo] das 10 sementes da referência ± a margem de `limites.json`.
 */

const AQUI = dirname(fileURLToPath(import.meta.url));
const DATA = join(AQUI, "../../../packages/engine/data");

export interface Limites {
  /** Margem relativa nas razões de preço (0,1 = 10%). */
  precos: number;
  /** Margem relativa nos negócios por bot. */
  negocios: number;
  /** Margem absoluta no retorno por perfil (0,05 = 5 pontos percentuais). */
  retorno: number;
}

export function lerLimites(): Limites {
  return JSON.parse(readFileSync(join(AQUI, "limites.json"), "utf8")) as Limites;
}

export interface Medidas {
  bandas: Record<string, { floor: number; center: number; ceiling: number }>;
  dividendosPorAcao: Record<string, number>;
  recompraPorAcao: Record<string, number>;
  precoFinalSobreIpo: number;
  negociosPorBot: number;
  bots: number;
  retornoPorPerfil: Record<string, number>;
}

/** Lê do banco do ensaio o que a comparação precisa. */
export async function extrairMedidas(servidor: ServidorEnsaio, carga: Carregado, cashInicial = 10_000_000): Promise<Medidas> {
  const db = servidor.conexao.db;
  const linhas = await db
    .select({ ticker: clubs.ticker, floor: seasonClubs.bandFloor, center: seasonClubs.bandCenter, ceiling: seasonClubs.bandCeiling, ipo: seasonClubs.ipoPrice, last: seasonClubs.lastPrice })
    .from(seasonClubs)
    .innerJoin(clubs, eq(clubs.id, seasonClubs.clubId))
    .where(eq(seasonClubs.seasonId, carga.seasonId));
  const bandas: Medidas["bandas"] = {};
  let somaIpo = 0;
  let somaFinal = 0;
  const precoFinal = new Map<number, number>();
  for (const l of linhas) {
    bandas[l.ticker!] = { floor: l.floor ?? 0, center: l.center ?? 0, ceiling: l.ceiling ?? 0 };
    somaIpo += l.ipo ?? 0;
    somaFinal += l.last ?? 0;
  }
  const eventos = await db
    .select({ ticker: clubs.ticker, kind: payoutEvents.kind, total: sql<number>`sum(${payoutEvents.perShare})::int` })
    .from(payoutEvents)
    .innerJoin(clubs, eq(clubs.id, payoutEvents.clubId))
    .where(and(eq(payoutEvents.seasonId, carga.seasonId), ne(payoutEvents.status, "superseded"), ne(payoutEvents.status, "pending")))
    .groupBy(clubs.ticker, payoutEvents.kind);
  const dividendosPorAcao: Record<string, number> = {};
  const recompraPorAcao: Record<string, number> = {};
  for (const e of eventos) (e.kind === "buyback" ? recompraPorAcao : dividendosPorAcao)[e.ticker!] = e.total;

  const [{ n, volume }] = (await db.select({ n: sql<number>`count(*)::int`, volume: sql<number>`coalesce(sum(${trades.price} * ${trades.quantity}), 0)::float` }).from(trades).where(eq(trades.seasonId, carga.seasonId))) as [{ n: number; volume: number }];
  void volume;
  void precoFinal;

  // retorno de cada bot: (caixa + ações × último preço) ÷ caixa inicial − 1, médio por perfil
  const carteiras = await db
    .select({ id: wallets.id, cash: wallets.cash, perfil: bots.profile })
    .from(wallets)
    .innerJoin(bots, eq(bots.id, wallets.botId))
    .where(eq(wallets.seasonId, carga.seasonId));
  const acoes = await db
    .select({ walletId: positions.walletId, valor: sql<number>`sum(${positions.shares} * ${seasonClubs.lastPrice})::float` })
    .from(positions)
    .innerJoin(seasonClubs, and(eq(seasonClubs.clubId, positions.clubId), eq(seasonClubs.seasonId, carga.seasonId)))
    .groupBy(positions.walletId);
  const valor = new Map(acoes.map((a) => [a.walletId, a.valor ?? 0]));
  const porPerfil = new Map<string, number[]>();
  for (const c of carteiras) {
    const retorno = (c.cash + (valor.get(c.id) ?? 0)) / cashInicial - 1;
    porPerfil.set(c.perfil, [...(porPerfil.get(c.perfil) ?? []), retorno]);
  }
  const retornoPorPerfil = Object.fromEntries([...porPerfil].map(([p, r]) => [p, r.reduce((a, b) => a + b, 0) / r.length]));
  return {
    bandas,
    dividendosPorAcao,
    recompraPorAcao,
    precoFinalSobreIpo: somaIpo > 0 ? somaFinal / somaIpo : 0,
    negociosPorBot: carteiras.length > 0 ? n / carteiras.length : 0,
    bots: carteiras.length,
    retornoPorPerfil,
  };
}

/** A simulação com as regras do jogo, só para os números que não dependem dos bots (1 bot por perfil: roda em segundos). */
export function referenciaExata(): { bandas: Medidas["bandas"]; dividendosPorAcao: Record<string, number>; recompraPorAcao: Record<string, number> } {
  const temporada = loadSeason(join(DATA, "brasileirao-2025.json"));
  const copa = (arq: string, rules: typeof LIBERTADORES) => ({ matches: (JSON.parse(readFileSync(join(DATA, arq), "utf8")) as { matches: Match[] }).matches, rules });
  const r = simulate(temporada, {
    bots: { dividendos: 1, momentum: 1, torcedor: 1, aleatorio: 1, trader: 1, captura: 1, analista: 1, concentrador: 1, antecipador: 1 },
    cups: [copa("libertadores-2025.json", LIBERTADORES), copa("copa-do-brasil-2025.json", COPA_DO_BRASIL), copa("sul-americana-2025.json", SULAMERICANA)],
    gameRules: true,
    rules: BRASILEIRAO_A,
  });
  const bandas: Medidas["bandas"] = {};
  const dividendosPorAcao: Record<string, number> = {};
  for (const c of r.clubs) {
    bandas[c.clubId] = { floor: c.band.min, center: c.band.center, ceiling: c.band.max };
    dividendosPorAcao[c.clubId] = c.dividendsPerShare;
  }
  // a recompra é buyback × a soma dos dividendos do clube (1,5 por padrão), arredondada
  const recompraPorAcao = Object.fromEntries(Object.entries(dividendosPorAcao).map(([t, d]) => [t, Math.round(d * r.config.buyback)]));
  return { bandas, dividendosPorAcao, recompraPorAcao };
}

export interface Linha {
  medida: string;
  ensaio: number | string;
  referencia: number | string;
  ok: boolean;
  /** Diferença esperada (com o motivo), quando a medida difere de propósito. */
  motivo?: string;
}

/** As diferenças conhecidas e esperadas entre o ensaio e a simulação (Dividendos, critério 6; classificação oficial). */
export const DIFERENCAS_ESPERADAS: Record<string, string> = {};

export function comparar(m: Medidas, exata: ReturnType<typeof referenciaExata>, lote: Array<Record<string, unknown>>, limites: Limites): Linha[] {
  const linhas: Linha[] = [];
  for (const [ticker, ref] of Object.entries(exata.bandas)) {
    const b = m.bandas[ticker];
    const ok = !!b && b.floor === ref.floor && b.center === ref.center && b.ceiling === ref.ceiling;
    linhas.push({ medida: `faixa do IPO ${ticker}`, ensaio: b ? `${b.floor}/${b.center}/${b.ceiling}` : "ausente", referencia: `${ref.floor}/${ref.center}/${ref.ceiling}`, ok, motivo: ok ? undefined : DIFERENCAS_ESPERADAS[`faixa ${ticker}`] });
  }
  for (const [ticker, ref] of Object.entries(exata.dividendosPorAcao)) {
    const v = m.dividendosPorAcao[ticker] ?? 0;
    linhas.push({ medida: `dividendos por ação ${ticker}`, ensaio: v, referencia: ref, ok: v === ref, motivo: v === ref ? undefined : DIFERENCAS_ESPERADAS[`dividendos ${ticker}`] });
  }
  for (const [ticker, ref] of Object.entries(exata.recompraPorAcao)) {
    const v = m.recompraPorAcao[ticker] ?? 0;
    linhas.push({ medida: `recompra por ação ${ticker}`, ensaio: v, referencia: ref, ok: v === ref, motivo: v === ref ? undefined : DIFERENCAS_ESPERADAS[`recompra ${ticker}`] });
  }
  const faixa = (nome: string, valor: number, valores: number[], margem: number, relativa: boolean) => {
    const min = Math.min(...valores);
    const max = Math.max(...valores);
    const folga = relativa ? margem * Math.max(Math.abs(min), Math.abs(max)) : margem;
    linhas.push({ medida: nome, ensaio: valor, referencia: `[${min.toFixed(3)}, ${max.toFixed(3)}] ± ${folga.toFixed(3)}`, ok: valor >= min - folga && valor <= max + folga });
  };
  faixa("preço final ÷ IPO", m.precoFinalSobreIpo, lote.map((l) => l.finalSobreIpo as number), limites.precos, true);
  // os negócios da referência são de 250 bots; o ensaio normaliza por bot
  faixa("negócios por bot", m.negociosPorBot, lote.map((l) => (l.negocios as number) / 250), limites.negocios, true);
  for (const [perfil, retorno] of Object.entries(m.retornoPorPerfil)) {
    faixa(`retorno médio ${perfil}`, retorno, lote.map((l) => (l.retorno as Record<string, number>)[perfil]!), limites.retorno, false);
  }
  return linhas;
}

/** Relatório em Markdown com a tabela das diferenças. */
export function relatorioMarkdown(linhas: Linha[]): string {
  const falhas = linhas.filter((l) => !l.ok);
  const topo = `# Comparação do ensaio com a simulação\n\n${linhas.length} medidas, ${falhas.length} fora do esperado.\n\n`;
  const tabela = (ls: Linha[]) => ["| Medida | Ensaio | Referência | Situação |", "|---|---|---|---|", ...ls.map((l) => `| ${l.medida} | ${l.ensaio} | ${l.referencia} | ${l.ok ? "ok" : l.motivo ? `esperada: ${l.motivo}` : "DIFERENTE"} |`)].join("\n");
  return topo + (falhas.length ? `## Diferenças\n\n${tabela(falhas)}\n\n` : "") + `## Todas\n\n${tabela(linhas)}\n`;
}
