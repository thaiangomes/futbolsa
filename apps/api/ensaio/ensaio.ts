import { eq } from "drizzle-orm";
import { finishTime } from "@futbolsa/engine";
import { COMPETITIONS } from "../src/infra/db/schema/values.js";
import { seasons } from "../src/infra/db/schema/index.js";
import { AgenteDeBots, ligarBots, contagemDeBots, type ResumoDosBots } from "./bots.js";
import { criarBancoDoEnsaio, type BancoDoEnsaio } from "./banco.js";
import { carregarTemporada2025, type Carregado } from "./carregar.js";
import { Condutor, DIA, type Ganchos, type Parada } from "./condutor.js";
import { Jogadores, type ResumoDosJogadores } from "./jogadores.js";
import { compararRankingOficialComRecalculado, fimDoMesDe, novoEstadoVerificador, verificarDia, type EstadoVerificador } from "./invariantes.js";
import { criarServidorEnsaio, type ServidorEnsaio } from "./servidor.js";

/** Sorteio com semente (mulberry32), para o ensaio se repetir. */
export function sorteioComSemente(semente: number): () => number {
  let a = semente >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface OpcoesEnsaio {
  /** URL do servidor Postgres local (o ensaio cria o banco dele ao lado). */
  urlBase: string;
  escala: number;
  semente: number;
  /** Temporada curta (as primeiras rodadas do Brasileirão): o ensaio rápido do `npm test`. */
  curta?: { rodadas: number };
  jogadores?: number;
  /** Para esta quantidade de dias depois da abertura da negociação (o ensaio rápido do npm test não vai até o fim da temporada). */
  ateDiasDepoisDaAbertura?: number;
  /** Ritmo dos bots: 180 minutos (comparável com a simulação) ou 15 (produção, P12). */
  tickMinutes?: number;
  /** Mantém o banco no fim. */
  manterBanco?: boolean;
  /** Roda o verificador em todo dia novo (padrão: sim). */
  verificar?: boolean;
  /** Ganchos extras (percalços). */
  ganchos?: Ganchos;
  /** Recebe o contexto antes de rodar (os percalços usam para se ligar ao condutor). */
  aoPreparar?(ctx: ContextoEnsaio): void | Promise<void>;
  log?(linha: string): void;
}

export interface ContextoEnsaio {
  servidor: ServidorEnsaio;
  carga: Carregado;
  condutor: Condutor;
  bots: AgenteDeBots;
  jogadores: Jogadores;
  estado: EstadoVerificador;
}

export interface ResultadoEnsaio {
  opcoes: { escala: number; semente: number; curta?: { rodadas: number }; jogadores: number; tickMinutes: number };
  banco: string;
  seasonId: number;
  statusFinal: string;
  inicio: string;
  fim: string;
  paradas: number;
  repeticoes: number;
  duracaoSegundos: number;
  memoriaMaximaMB: number;
  bots: { contagem: Record<string, number>; resumo: ResumoDosBots };
  jogadores: ResumoDosJogadores;
  diasVerificados: number;
  rankingsConferidos: string[];
}

/** Roda o ensaio da abertura do IPO até a negociação encerrada e a recompra paga; devolve o que foi feito. */
export async function executarEnsaio(o: OpcoesEnsaio): Promise<{ resultado: ResultadoEnsaio; ctx: ContextoEnsaio; fechar(): Promise<void> }> {
  const log = o.log ?? (() => {});
  const t0 = Date.now();
  let pico = 0;
  const banco: BancoDoEnsaio = await criarBancoDoEnsaio(o.urlBase);
  const contagem = contagemDeBots(o.escala);
  const totalBots = Object.values(contagem).reduce((a, b) => a + b, 0);
  const nJogadores = o.jogadores ?? 6;
  const tick = o.tickMinutes ?? 180;
  const servidor = await criarServidorEnsaio({
    databaseUrl: banco.url,
    inicio: new Date("2025-03-01T12:00:00Z"),
    poolSize: 20,
    curta: o.curta,
    bots: { tickMinutes: tick, activityPer3h: 0.25 },
  });
  const carga = await carregarTemporada2025(servidor, { offerSize: 150 * (totalBots + nJogadores) });
  servidor.clock.set(new Date(carga.ipo.opensAt.getTime() - DIA));
  await ligarBots(servidor, carga, o.escala);
  const bots = new AgenteDeBots(servidor, sorteioComSemente(o.semente + 1), tick);
  const jogadores = new Jogadores(servidor, carga, { quantos: nJogadores, sorteio: sorteioComSemente(o.semente + 2) });
  const estado = novoEstadoVerificador();
  let cadastrados = false;
  const condutor: Condutor = new Condutor(servidor, carga, {
    sorteio: sorteioComSemente(o.semente + 3),
    ganchos: {
      antes: async (p) => {
        await o.ganchos?.antes?.(p);
      },
      agir: async (p: Parada) => {
        if (!cadastrados && p.em >= carga.ipo.opensAt) {
          await jogadores.cadastrar(carga.tickers);
          cadastrados = true;
        }
        await bots.agir(p);
        if (cadastrados) await jogadores.agir(p);
        await o.ganchos?.agir?.(p);
      },
      depois: async (p: Parada) => {
        pico = Math.max(pico, process.memoryUsage().rss);
        if (o.verificar !== false && (p.novoDia || fimDoMesDe(p.em))) {
          await verificarDia(servidor, carga.seasonId, p, estado);
          if (cadastrados && p.novoDia) await jogadores.conferirLivrosDoOuvinte();
        }
        await o.ganchos?.depois?.(p);
      },
    },
  });
  const ctx: ContextoEnsaio = { servidor, carga, condutor, bots, jogadores, estado };
  await o.aoPreparar?.(ctx);

  // até o fim do último jogo mais 40 dias (placar, aprovação, recompra), ou até a temporada sair da negociação
  let ultimoJogo = 0;
  for (const c of COMPETITIONS) for (const m of servidor.fonte.matchesOf(c)) ultimoJogo = Math.max(ultimoJogo, finishTime(m));
  let fim = new Date(ultimoJogo + 40 * DIA);
  if (o.ateDiasDepoisDaAbertura !== undefined) fim = new Date(carga.ipo.tradingOpensAt.getTime() + o.ateDiasDepoisDaAbertura * DIA);
  const status = async () => (await servidor.conexao.db.select().from(seasons).where(eq(seasons.id, carga.seasonId)))[0]!.status;
  await condutor.rodarAte(fim, async () => {
    const s = await status();
    return s === "trading_ended" || s === "closed";
  });
  log(`ensaio parou em ${servidor.clock.now().toISOString()} com a temporada em ${await status()}`);
  const rankings = o.verificar !== false ? (await compararRankingOficialComRecalculado(servidor, carga.seasonId, estado)).rankings : [];
  jogadores.fechar();
  const resultado: ResultadoEnsaio = {
    opcoes: { escala: o.escala, semente: o.semente, curta: o.curta, jogadores: nJogadores, tickMinutes: tick },
    banco: banco.nome,
    seasonId: carga.seasonId,
    statusFinal: await status(),
    inicio: new Date(carga.ipo.opensAt.getTime() - DIA).toISOString(),
    fim: servidor.clock.now().toISOString(),
    paradas: condutor.paradas,
    repeticoes: condutor.repeticoes,
    duracaoSegundos: (Date.now() - t0) / 1000,
    memoriaMaximaMB: Math.round(pico / 1_048_576),
    bots: { contagem, resumo: bots.resumo },
    jogadores: jogadores.resumo,
    diasVerificados: estado.dias,
    rankingsConferidos: rankings,
  };
  return {
    resultado,
    ctx,
    fechar: async () => {
      await servidor.fechar();
      if (!o.manterBanco) await banco.apagar();
    },
  };
}
