import { AgenteDeBots } from "../ensaio/bots.js";
import type { Parada } from "../ensaio/condutor.js";
import type { ServidorEnsaio } from "../ensaio/servidor.js";

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
/** Até este intervalo entre rodadas, vale o ritmo do tempo real. */
const INTERVALO_DO_TEMPO_REAL = 15;

export class AgenteDaPartida {
  private ultima = 0;
  private readonly agente: AgenteDeBots;

  constructor(
    servidor: ServidorEnsaio,
    /** A mesma configuração que o `BotRunnerSettings` da API lê. */
    private readonly config: { tickMinutes: number; activityPer3h: number },
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
    this.config.activityPer3h = minutos <= INTERVALO_DO_TEMPO_REAL ? ATIVIDADE_NO_TEMPO_REAL : ATIVIDADE_DOS_SALTOS;
    this.ultima = em;
    await this.agente.agir(parada);
  }
}
