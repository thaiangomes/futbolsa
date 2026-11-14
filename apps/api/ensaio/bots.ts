import { BOT_PROFILE_NAMES, type BotProfileName } from "@futbolsa/contracts";
import { BotRunner, type BotRunReport } from "../src/modules/admin/bots/runner.js";
import { bots as botsTabela, wallets } from "../src/infra/db/schema/index.js";
import { eq } from "drizzle-orm";
import type { Carregado } from "./carregar.js";
import type { Parada } from "./condutor.js";
import type { ServidorEnsaio } from "./servidor.js";

/**
 * Bots do ensaio (T6, P6 e P12): os 9 perfis em toda execução. `escala` multiplica o número de bots de cada perfil
 * (mínimo 1, então nenhum perfil some). A escala 1 é a da simulação: 25 de cada perfil e 50 traders (275 bots).
 */

export const BOTS_POR_PERFIL: Record<BotProfileName, number> = {
  dividendos: 25,
  momentum: 25,
  torcedor: 25,
  aleatorio: 25,
  trader: 50,
  captura: 25,
  analista: 25,
  concentrador: 25,
  antecipador: 25,
};

export function contagemDeBots(escala: number): Record<BotProfileName, number> {
  if (!(escala > 0)) throw new Error(`escala inválida: ${escala}`);
  return Object.fromEntries(BOT_PROFILE_NAMES.map((p) => [p, Math.max(1, Math.round(BOTS_POR_PERFIL[p] * escala))])) as Record<BotProfileName, number>;
}

/** Liga os bots pelo admin (`PATCH /admin/bots`), como o Thaian faria, e confere que nenhum perfil ficou sem bot. */
export async function ligarBots(servidor: ServidorEnsaio, carga: Carregado, escala: number): Promise<Record<BotProfileName, number>> {
  const contagem = contagemDeBots(escala);
  const res = await servidor.app.inject({ method: "PATCH", url: "/admin/bots", payload: { counts: contagem }, headers: await carga.admin.auth() });
  if (res.statusCode >= 300) throw new Error(`PATCH /admin/bots → ${res.statusCode}: ${res.body}`);
  const ativos = await servidor.conexao.db.select({ profile: botsTabela.profile }).from(botsTabela).where(eq(botsTabela.active, true));
  for (const perfil of BOT_PROFILE_NAMES) {
    if (!ativos.some((b) => b.profile === perfil)) throw new Error(`o perfil ${perfil} ficou sem bot`);
  }
  return contagem;
}

/** O que os bots fizeram no ensaio, somado de todas as rodadas. */
export interface ResumoDosBots {
  rodadas: number;
  ordens: number;
  cancelamentos: number;
  ofertas: number;
  carteiras: number;
  recusas: Record<string, number>;
}

/**
 * A rodada dos bots no ritmo escolhido (P12): chama o executor da F14 a cada `tickMinutes` do relógio simulado (180 no ensaio
 * comparável, 15 no ritmo de produção), com sorteio de semente fixa. Nas paradas entre dois ritmos não faz nada.
 */
export class AgenteDeBots {
  readonly resumo: ResumoDosBots = { rodadas: 0, ordens: 0, cancelamentos: 0, ofertas: 0, carteiras: 0, recusas: {} };
  private ultima = 0;

  constructor(
    private readonly servidor: ServidorEnsaio,
    private readonly sorteio: () => number,
    private readonly tickMinutes = 180,
  ) {}

  async agir(parada: Parada): Promise<BotRunReport | null> {
    if (parada.em.getTime() - this.ultima < this.tickMinutes * 60_000) return null;
    this.ultima = parada.em.getTime();
    const relatorio = await this.servidor.app.get(BotRunner, { strict: false }).runOnce(parada.em, this.sorteio);
    if (relatorio.skipped) return relatorio;
    this.resumo.rodadas++;
    this.resumo.ordens += relatorio.placed;
    this.resumo.cancelamentos += relatorio.cancelled;
    this.resumo.ofertas += relatorio.bids;
    this.resumo.carteiras += relatorio.wallets;
    for (const [codigo, n] of Object.entries(relatorio.refused)) this.resumo.recusas[codigo] = (this.resumo.recusas[codigo] ?? 0) + n;
    return relatorio;
  }
}

/** As carteiras de bot da temporada (para os verificadores). */
export async function carteirasDeBots(servidor: ServidorEnsaio, seasonId: number): Promise<number> {
  const linhas = await servidor.conexao.db.select({ id: wallets.id, botId: wallets.botId, seasonId: wallets.seasonId }).from(wallets);
  return linhas.filter((l) => l.botId !== null && l.seasonId === seasonId).length;
}
