import { AgenteDeBots } from "../ensaio/bots.js";
import type { Parada } from "../ensaio/condutor.js";
import type { ServidorEnsaio } from "../ensaio/servidor.js";
import type { AttentionClubs } from "../src/modules/admin/bots/partial-scores.js";

/**
 * Os bots da partida: o executor da F14 (`BotRunner`) pelas mesmas rotas dos humanos. A chance de cada bot agir numa rodada é
 * `activityPer3h × tickMinutes ÷ 180`; como as paradas da partida têm tamanhos diferentes (5 minutos no tempo real, até 180
 * nos saltos), o intervalo desde a última rodada entra como `tickMinutes` e o ritmo médio (0,25 a cada 3 horas) se mantém.
 */
/** A chance de cada bot agir a cada 3 horas nos saltos do relógio (paradas de 15 minutos a 3 horas): o ritmo da simulação calibrada. */
export const ATIVIDADE_DOS_SALTOS = 0.25;
/**
 * No tempo real (paradas de 5 minutos) os bots agem mais (item 23): 1 por bot a cada 3 horas, uns 17 por hora com 50 bots, para
 * o mercado se mexer enquanto o jogador acompanha os jogos. Nos saltos o ritmo continua o de antes, para o salto não ficar lento.
 */
export const ATIVIDADE_NO_TEMPO_REAL = 1;
/**
 * Na rodada em que aparece um gol novo (item 23), os bots agem bem mais: 6 por bot a cada 3 horas, ou seja, uns 17% dos bots na
 * parada de 5 minutos (uns 8 de 50). O gol muda o valor justo só ~1% (R$ 0,10 por ponto), pouco para o preço reagir se ninguém
 * negociar; assim o mercado reage na hora, sem esperar o sorteio de cada bot.
 */
export const ATIVIDADE_NO_GOL = 6;
/** Até este intervalo entre rodadas, vale o ritmo do tempo real. */
const INTERVALO_DO_TEMPO_REAL = 15;

/** Os gols de cada jogo em andamento agora (a leitura que o agente compara de uma parada para a outra). */
export type PlacarAgora = () => ReadonlyArray<{ home: string; away: string; homeGoals: number; awayGoals: number }>;

export class AgenteDaPartida {
  private ultima = 0;
  /** Gols de cada jogo na parada anterior; `undefined` até a primeira leitura (reiniciar a partida com jogo rolando não conta como gol). */
  private golsAntes: Map<string, number> | undefined;
  private readonly agente: AgenteDeBots;

  constructor(
    servidor: ServidorEnsaio,
    /** A mesma configuração que o `BotRunnerSettings` da API lê. */
    private readonly config: { tickMinutes: number; activityPer3h: number },
    /** Os placares parciais de agora; sem isto os bots nunca têm a rodada extra do gol. */
    private readonly placar?: PlacarAgora,
    /** Onde o agente deixa os clubes do gol para a rodada dos bots olhar primeiro; sem isto não há atenção. */
    private readonly foco?: FocoDosBots,
  ) {
    this.agente = new AgenteDeBots(servidor, Math.random, 0);
  }

  /** O que os bots fizeram até agora. */
  get resumo() {
    return this.agente.resumo;
  }

  async agir(parada: Parada): Promise<void> {
    const em = parada.em.getTime();
    const minutos = this.ultima === 0 ? 15 : (em - this.ultima) / 60_000;
    if (minutos < 1) return;
    this.config.tickMinutes = Math.min(180, minutos);
    const tempoReal = minutos <= INTERVALO_DO_TEMPO_REAL;
    const clubesDoGol = this.golsNovos(); // lê sempre, para o ponto de partida não ficar velho depois de um salto
    const gol = tempoReal && clubesDoGol.length > 0;
    this.config.activityPer3h = tempoReal ? (gol ? ATIVIDADE_NO_GOL : ATIVIDADE_NO_TEMPO_REAL) : ATIVIDADE_DOS_SALTOS;
    this.ultima = em;
    // só nesta rodada, parte dos bots que agem olha primeiro para os clubes do jogo do gol
    if (this.foco && gol) this.foco.emFoco = clubesDoGol;
    try {
      await this.agente.agir(parada);
    } finally {
      if (this.foco) this.foco.emFoco = [];
    }
  }

  /** Os clubes dos jogos que ganharam gol desde a parada anterior. A primeira leitura só guarda o ponto de partida. */
  private golsNovos(): string[] {
    if (!this.placar) return [];
    const agora = new Map<string, number>();
    const clubes = new Map<string, [string, string]>();
    for (const m of this.placar()) {
      const jogo = `${m.home}-${m.away}`;
      agora.set(jogo, m.homeGoals + m.awayGoals);
      clubes.set(jogo, [m.home, m.away]);
    }
    const antes = this.golsAntes;
    this.golsAntes = agora;
    if (!antes) return [];
    const out: string[] = [];
    for (const [jogo, gols] of agora) if (gols > (antes.get(jogo) ?? 0)) out.push(...clubes.get(jogo)!);
    return out;
  }
}

/** Os clubes em foco na rodada dos bots: a partida preenche na parada com gol novo e a API dos bots lê (`AttentionClubs`). */
export class FocoDosBots implements AttentionClubs {
  emFoco: string[] = [];
  clubs(): readonly string[] {
    return this.emFoco;
  }
}
