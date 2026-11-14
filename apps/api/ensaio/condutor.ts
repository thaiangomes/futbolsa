import { and, eq, lte } from "drizzle-orm";
import { finishTime, kickoffTime, type Match } from "@futbolsa/engine";
import { COMPETITIONS } from "../src/infra/db/schema/values.js";
import { payoutEvents } from "../src/infra/db/schema/index.js";
import { EquityDailyService } from "../src/modules/portfolio/daily/equity-daily.service.js";
import { SnapshotService } from "../src/modules/portfolio/snapshots/snapshot.service.js";
import { CloseService } from "../src/modules/rankings/close.service.js";
import { RecalcService } from "../src/modules/rankings/recalc.service.js";
import { ImportRunner } from "../src/modules/admin/results/import-runner.js";
import { CloseEventsJob } from "../src/modules/admin/payouts/close-events.job.js";
import { SettleJob } from "../src/modules/admin/payouts/settle.job.js";
import { IpoJob } from "../src/modules/ipo/ipo.job.js";
import { OpeningJob } from "../src/modules/market/opening/opening.job.js";
import { RefreshJob } from "../src/modules/market/maker/refresh.job.js";
import { MarketJobs } from "../src/infra/jobs/market-jobs.js";
import type { Carregado } from "./carregar.js";
import type { ServidorEnsaio } from "./servidor.js";

/**
 * Condutor do relógio (T5, P2 do Plano do ensaio): o relógio salta de um instante interessante a outro (no máximo 3 horas de
 * cada vez, como a simulação) e, em cada parada, chama as passadas das tarefas na ordem de produção, sem esperar nenhum
 * temporizador. Para na primeira passada que falha, dizendo o instante e a passada.
 */

export const HORA = 3_600_000;
export const DIA = 24 * HORA;
/** Brasília é UTC-3 o ano todo (sem horário de verão desde 2019): meia-noite de lá é 03:00 UTC. */
const BRT = 3 * HORA;

export interface Parada {
  /** O instante simulado desta parada. */
  em: Date;
  /** O que a tornou interessante (a menor das razões). */
  motivo: string;
  /** Primeira parada de um novo dia de Brasília. */
  novoDia: boolean;
}

export interface Ganchos {
  /** Os bots e os jogadores de teste agem (depois do mercado, antes da aprovação do admin). */
  agir?(parada: Parada): Promise<void>;
  /** Percalços marcados: roda antes das passadas da parada. */
  antes?(parada: Parada): Promise<void>;
  /** Depois de todas as passadas (o verificador de invariantes roda aqui, uma vez por dia). */
  depois?(parada: Parada): Promise<void>;
}

export interface OpcoesCondutor {
  /** Quanto o admin de teste espera depois do fechamento de um evento antes de aprová-lo (padrão 1 hora). */
  atrasoAprovacaoMs?: number;
  /** Sorteio com semente: quais paradas repetem as passadas (provar que repetir não duplica). */
  sorteio?: () => number;
  /** Chance de uma parada repetir todas as passadas (padrão 3%). */
  chanceDeRepetir?: number;
  /** O admin de teste aprova os pagamentos (desligue para testar a aprovação à mão). */
  aprovar?: boolean;
  ganchos?: Ganchos;
}

export class ErroDeParada extends Error {
  constructor(
    readonly parada: Parada,
    readonly passada: string,
    causa: unknown,
  ) {
    super(`falhou em ${passada} às ${parada.em.toISOString()} (${parada.motivo}): ${(causa as Error).message}`, { cause: causa });
  }
}

export class Condutor {
  private readonly instantes: Array<{ at: number; motivo: string }>;
  private ultimoDia: number;
  /** Quantas paradas e repetições já aconteceram (para o relatório). */
  paradas = 0;
  repeticoes = 0;
  readonly log: string[] = [];
  /** Milissegundos gastos em cada passada e em cada gancho, somados (para achar onde o ensaio gasta o tempo). */
  readonly tempos: Record<string, number> = {};

  constructor(
    private readonly servidor: ServidorEnsaio,
    private readonly carga: Carregado,
    private readonly opcoes: OpcoesCondutor = {},
  ) {
    this.instantes = this.calcularInstantes();
    this.ultimoDia = this.diaDe(servidor.clock.now().getTime());
  }

  private diaDe(ms: number): number {
    return Math.floor((ms - BRT) / DIA);
  }

  private get<T>(tipo: abstract new (...args: never[]) => T): T {
    return this.servidor.app.get(tipo as never, { strict: false }) as T;
  }

  /** As datas fixas que não caem na grade de 3 horas: IPO, jogos e fim dos jogos, fim do mês às 23h59 de Brasília. */
  private calcularInstantes(): Array<{ at: number; motivo: string }> {
    const lista = new Map<number, string>();
    const marcar = (at: number, motivo: string) => {
      if (!lista.has(at)) lista.set(at, motivo);
    };
    marcar(this.carga.ipo.opensAt.getTime(), "abertura do IPO");
    marcar(this.carga.ipo.closesAt.getTime(), "fechamento do IPO");
    marcar(this.carga.ipo.tradingOpensAt.getTime(), "abertura da negociação");
    for (const competicao of COMPETITIONS) {
      for (const m of this.servidor.fonte.matchesOf(competicao) as Match[]) {
        marcar(kickoffTime(m), "início de jogo");
        marcar(finishTime(m), "fim de jogo");
      }
    }
    // 23h59 de Brasília do último dia de cada mês de 2025 e 2026
    for (let ano = this.carga.year; ano <= this.carga.year + 1; ano++) {
      for (let mes = 0; mes < 12; mes++) {
        const fimDoMes = Date.UTC(ano, mes + 1, 1, 3, 0, 0) - 60_000;
        marcar(fimDoMes, "fim do mês");
      }
    }
    return [...lista].map(([at, motivo]) => ({ at, motivo })).sort((a, b) => a.at - b.at);
  }

  /** O próximo instante interessante depois de `agora`, no máximo 3 horas à frente. */
  proxima(agora: Date): { em: Date; motivo: string } {
    const t = agora.getTime();
    const grade = (Math.floor((t - BRT) / (3 * HORA)) + 1) * 3 * HORA + BRT;
    let melhor = { at: grade, motivo: grade === Math.floor((t - BRT) / DIA + 1) * DIA + BRT ? "0h" : "grade de 3 horas" };
    // busca binária do primeiro instante fixo depois de t
    let lo = 0;
    let hi = this.instantes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.instantes[mid]!.at > t) hi = mid;
      else lo = mid + 1;
    }
    const fixo = this.instantes[lo];
    if (fixo && fixo.at < melhor.at) melhor = fixo;
    return { em: new Date(melhor.at), motivo: melhor.motivo };
  }

  /** Avança o relógio até a próxima parada e roda as passadas. */
  async paradaUnica(): Promise<Parada> {
    const { em, motivo } = this.proxima(this.servidor.clock.now());
    this.servidor.clock.set(em);
    const dia = this.diaDe(em.getTime());
    const parada: Parada = { em, motivo, novoDia: dia !== this.ultimoDia };
    this.ultimoDia = dia;
    this.paradas++;
    await this.executar(parada, "antes", () => this.opcoes.ganchos?.antes?.(parada));
    await this.passadas(parada);
    const repetir = (this.opcoes.sorteio?.() ?? 1) < (this.opcoes.chanceDeRepetir ?? 0.03);
    if (repetir) {
      this.repeticoes++;
      await this.passadas(parada, true);
    }
    await this.executar(parada, "agir", () => this.opcoes.ganchos?.agir?.(parada));
    await this.aprovarEPagar(parada);
    await this.executar(parada, "depois", () => this.opcoes.ganchos?.depois?.(parada));
    return parada;
  }

  /** Para quando `parar` diz que sim (depois de cada parada) ou o relógio passa de `fim`. */
  async rodarAte(fim: Date, parar: () => Promise<boolean> | boolean = () => false): Promise<void> {
    while (this.servidor.clock.now() < fim) {
      await this.paradaUnica();
      if (await parar()) return;
    }
  }

  /**
   * Para o navegador (T19): avança parada a parada só enquanto a próxima ainda cai até `alvo` e termina exatamente em `alvo`
   * (com as passadas rodadas nesse instante), em vez de pular por cima dele até a próxima parada.
   */
  async ateExato(alvo: Date): Promise<void> {
    while (this.proxima(this.servidor.clock.now()).em <= alvo) await this.paradaUnica();
    if (this.servidor.clock.now() < alvo) {
      this.servidor.clock.set(alvo);
      const dia = this.diaDe(alvo.getTime());
      const parada: Parada = { em: alvo, motivo: "alvo do navegador", novoDia: dia !== this.ultimoDia };
      this.ultimoDia = dia;
      this.paradas++;
      await this.passadas(parada);
    }
  }

  private async executar<T>(parada: Parada, passada: string, run: () => Promise<T> | T): Promise<T> {
    const inicio = performance.now();
    try {
      return await run();
    } catch (error) {
      throw new ErroDeParada(parada, passada, error);
    } finally {
      const nome = passada.replace(" (repetida)", "");
      this.tempos[nome] = (this.tempos[nome] ?? 0) + (performance.now() - inicio);
    }
  }

  /** As passadas das tarefas, na ordem de produção (importar, fechar eventos, IPO, abertura, reposição, leilões, patrimônio e rankings). */
  private async passadas(parada: Parada, repeticao = false): Promise<void> {
    const sufixo = repeticao ? " (repetida)" : "";
    const rodar = <T>(nome: string, run: () => Promise<T>) => this.executar(parada, nome + sufixo, run);
    const importador = this.get(ImportRunner);
    await rodar("importar calendário", () => importador.runCalendarIfStale());
    await rodar("importar placares", () => importador.runScores());
    await rodar("fechar eventos de pagamento", () => this.get(CloseEventsJob).run(this.carga.seasonId));
    await rodar("ipo", () => this.get(IpoJob).runOnce());
    await rodar("abrir negociação", () => this.get(OpeningJob).runOnce(parada.em));
    await rodar("repor formador", () => this.get(RefreshJob).runDue(parada.em));
    await rodar("fim dos leilões", () => this.get(MarketJobs).closeAuctions());
    await rodar("patrimônio do dia", () => this.get(EquityDailyService).runOnce(parada.em));
    await rodar("foto mensal", () => this.get(SnapshotService).runOnce(parada.em));
    await rodar("fechar meses do ranking", () => this.get(CloseService).runOnce(parada.em));
    await rodar("recalcular rankings", () => this.get(RecalcService).processRecalcRequests(parada.em));
  }

  /** O admin de teste aprova o que fechou há mais de N horas e roda a liquidação dos créditos em lotes. */
  async aprovarEPagar(parada: Parada): Promise<void> {
    if (this.opcoes.aprovar === false) return;
    const atraso = this.opcoes.atrasoAprovacaoMs ?? HORA;
    await this.executar(parada, "aprovar pagamentos", async () => {
      const maduros = await this.servidor.conexao.db
        .select({ id: payoutEvents.id })
        .from(payoutEvents)
        .where(and(eq(payoutEvents.seasonId, this.carga.seasonId), eq(payoutEvents.status, "pending"), lte(payoutEvents.closedAt, new Date(parada.em.getTime() - atraso))));
      if (maduros.length === 0) return;
      for (let i = 0; i < maduros.length; i += 500) {
        const res = await this.servidor.app.inject({
          method: "POST",
          url: "/admin/payouts/approve",
          payload: { eventIds: maduros.slice(i, i + 500).map((e) => e.id) },
          headers: await this.carga.admin.auth(),
        });
        if (res.statusCode >= 300) throw new Error(`aprovação → ${res.statusCode}: ${res.body}`);
        const semClassificacao = (res.json() as { results: Array<{ outcome: string }> }).results.some((r) => r.outcome === "standings_not_confirmed");
        if (semClassificacao) {
          const conf = await this.servidor.app.inject({ method: "POST", url: "/admin/standings/brasileirao-a/confirm", headers: await this.carga.admin.auth() });
          if (conf.statusCode >= 300) throw new Error(`confirmar classificação → ${conf.statusCode}: ${conf.body}`);
        }
      }
    });
    await this.executar(parada, "liquidar créditos", () => this.get(SettleJob).run());
  }
}
