import { finishTime, kickoffTime, type Match } from "@futbolsa/engine";
import { FixedClock } from "../src/infra/clock/index.js";
import { DomainError } from "../src/infra/http/errors.js";
import { CLOSE_MARGIN_MS } from "../src/modules/admin/payouts/close-events.service.js";
import type { Condutor } from "../ensaio/condutor.js";
import type { ReplaySource } from "../ensaio/replay-source.js";
import { paraMemoria, type Fotos } from "./dados.js";

/**
 * O relógio da partida (F17, T6). Um só para todos os jogadores, em dois estados:
 * - **pausado:** o instante do jogo fica parado; os jogadores leem o mercado e mandam ordens normalmente;
 * - **tempo real:** um minuto de verdade é um minuto do jogo, com uma parada (as passadas de produção e os bots) a cada 5 minutos.
 * Em qualquer um dos dois o admin pede um **salto** (1 dia, até a próxima rodada, até uma data): paradas de 180 minutos, um pedido
 * por vez, e depois o relógio volta ao estado em que estava. O relógio **nunca passa do último jogo terminado** nos dados
 * ("aguardando resultados reais") e nunca anda para trás. **Exceção (item 23):** com dados baixados há poucos minutos, tudo o que
 * terminou até agora já está neles, e o relógio pode ir até a hora real; no tempo real, perto da hora real, a partida baixa os
 * dados sozinha a cada 5 minutos e o relógio acompanha a hora de verdade, com jogo em andamento ou não. O estado é gravado no banco a cada parada; ao ligar de novo, volta pausado.
 */

const MINUTO = 60_000;
const HORA = 60 * MINUTO;
const DIA = 24 * HORA;
export const PASSO_TEMPO_REAL = 5 * MINUTO;
/** Os dados baixados há menos que isto valem como "tudo o que terminou até agora" (duas baixas automáticas de folga). */
export const FRESCOR_DOS_DADOS = 12 * MINUTO;
/** No tempo real, perto da hora real, a baixa automática dos dados acontece a cada tanto (a parada de 5 minutos a dispara). */
export const BAIXA_AUTOMATICA = 5 * MINUTO;
/** "Perto da hora real": a baixa automática só roda com o relógio a no máximo isto da hora de verdade. */
export const PERTO_DA_HORA_REAL = 30 * MINUTO;
/** O pedido "agora" repete o salto até o relógio ficar a no máximo isto da hora real (o último salto é curto). */
const ATRASO_ACEITO = 5 * MINUTO;
export const PASSO_SALTO = 180 * MINUTO;
/** Os jogos de uma rodada que começam até aqui do primeiro dela contam para o fim da rodada; os remarcados para depois não. */
const JANELA_DA_RODADA = 7 * DIA;
/** O fechamento de um jogo espera 2 minutos depois do fim (margem da produção): o relógio vai um minuto além dela, para o fechamento já ter rodado. */
export const MARGEM_DO_FECHAMENTO = CLOSE_MARGIN_MS + MINUTO;

/** O relógio da API na partida: fixo entre as paradas quando pausado, e andando junto com o relógio de verdade no tempo real. */
export class RelogioFlutuante extends FixedClock {
  private correndo = false;
  private ancora = 0;

  constructor(
    inicio: Date,
    private readonly agoraReal: () => number = () => Date.now(),
  ) {
    super(inicio);
  }

  override now(): Date {
    const base = super.now();
    return this.correndo ? new Date(base.getTime() + (this.agoraReal() - this.ancora)) : base;
  }

  /** O relógio nunca anda para trás: no tempo real, pôr um instante que já passou mantém o de agora. */
  override set(instante: Date): void {
    const alvo = this.correndo && instante < this.now() ? this.now() : instante;
    super.set(alvo);
    if (this.correndo) this.ancora = this.agoraReal();
  }

  override advance(ms: number): void {
    this.set(new Date(this.now().getTime() + ms));
  }

  correr(): void {
    if (this.correndo) return;
    this.ancora = this.agoraReal();
    this.correndo = true;
  }

  congelar(): void {
    if (!this.correndo) return;
    const agora = this.now();
    this.correndo = false;
    super.set(agora);
  }

  get andando(): boolean {
    return this.correndo;
  }
}

export type Modo = "pausado" | "tempo-real";

export type Pedido = { acao: "agora" } | { acao: "dia" } | { acao: "rodada" } | { acao: "ate"; data: string } | { acao: "atualizar" } | { acao: "pausar" } | { acao: "tempo-real" };

export interface EstadoDoRelogio {
  instante: string;
  modo: Modo;
  /** O fim do último jogo terminado nos dados: o relógio não passa daqui. */
  limite: string | null;
  /** O relógio está no limite: falta resultado real para ele andar. */
  aguardando: boolean;
  /** Início do último jogo terminado (para a tela dizer "último resultado em ..."). */
  ultimoResultado: string | null;
  /** O que está andando agora (um salto, uma atualização), ou `null`. */
  ocupado: string | null;
  /** Data da foto de dados mais nova. */
  dadosDe: string | null;
  /** Quando os dados foram baixados pela última vez (hora real), mesmo que nada tenha mudado; `null` desde que a partida subiu até a primeira baixa. */
  baixadoEm: string | null;
  /** Os dados foram baixados há pouco e o relógio pode ir até a hora real (item 23). */
  dadosFrescos: boolean;
}

export interface RespostaDoRelogio {
  estado: EstadoDoRelogio;
  /** O relógio saiu do lugar. */
  avancou: boolean;
  mensagem: string;
}

export interface DepsDoRelogio {
  clock: RelogioFlutuante;
  condutor: Condutor;
  fonte: ReplaySource;
  /** Grava o instante do relógio no banco. */
  salvar(instante: Date): Promise<void>;
  /** Baixa os dados de novo e grava as fotos que mudaram (`atualizarFotos`). */
  atualizar(): Promise<{ mudaram: string[]; limiteAntes: number | null; limiteDepois: number | null; fotos: Fotos }>;
  /** Data da foto mais nova (para a tela). */
  dadosDe?: () => string | null;
  /** A hora real em milissegundos (os testes trocam; o padrão é o relógio do computador). */
  agoraReal?: () => number;
  /** Espera de verdade (os testes trocam). */
  esperar?: (ms: number) => Promise<void>;
  /** Liga o laço do tempo real sozinho (os testes ligam à mão com `tique`). */
  laco?: boolean;
}

/** O dia e o mês de Brasília de um instante (`23/07`). */
function diaDeBrasilia(ms: number): string {
  const p = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" }).formatToParts(new Date(ms));
  return `${p.find((x) => x.type === "day")?.value}/${p.find((x) => x.type === "month")?.value}`;
}

const ocupado = () => new DomainError("relogio_ocupado", 409, "o relógio já está andando");

export class RelogioDaPartida {
  private modo: Modo = "pausado";
  private emAndamento: string | null = null;
  /** A parada do tempo real em curso (o salto e a pausa esperam por ela). */
  private paradaAtual: Promise<unknown> = Promise.resolve();
  private ultimaParada: number;
  /** Quando os dados foram baixados da ESPN pela última vez (hora real, ms); só na memória: ao subir, os dados são os do banco. */
  private baixadoEm: number | null = null;
  private geracao = 0;
  private cancelarEspera: (() => void) | null = null;
  /** O Thaian pediu para pausar com um salto andando: o salto para ao fim da parada atual. */
  private interromper = false;
  /** Quem espera o salto em andamento acabar (o pausar). */
  private fimDoSalto: Promise<unknown> = Promise.resolve();

  constructor(private readonly d: DepsDoRelogio) {
    this.ultimaParada = d.clock.now().getTime();
  }

  // ---------- leitura ----------

  /**
   * O limite do relógio: o fim do último jogo terminado nos dados mais a margem do fechamento (o placar já foi importado e o
   * fechamento dele já rodou). Daí em diante é "aguardando resultados reais".
   */
  limiteMs(): number | null {
    const base = this.limiteDosJogos();
    // dados baixados há pouco: o que terminou até agora já está neles, e o relógio pode ir até a hora real
    return this.liberto() ? Math.max(base ?? Number.NEGATIVE_INFINITY, this.agoraReal()) : base;
  }

  /** O fim do último jogo terminado nos dados mais a margem do fechamento. */
  private limiteDosJogos(): number | null {
    const fim = this.d.fonte.limite();
    return fim === null ? null : fim + MARGEM_DO_FECHAMENTO;
  }

  private agoraReal(): number {
    return this.d.agoraReal?.() ?? Date.now();
  }

  private dadosFrescos(): boolean {
    return this.baixadoEm !== null && this.agoraReal() - this.baixadoEm <= FRESCOR_DOS_DADOS;
  }

  /** Dados frescos e a hora real já além do último jogo terminado: o relógio não está preso ao limite dos jogos, só à hora real. */
  private liberto(): boolean {
    if (!this.dadosFrescos()) return false;
    const base = this.limiteDosJogos();
    return base === null || this.agoraReal() > base;
  }

  private limite(): number | null {
    return this.limiteMs();
  }

  estado(): EstadoDoRelogio {
    const limite = this.limite();
    const agora = this.d.clock.now().getTime();
    return {
      instante: new Date(agora).toISOString(),
      modo: this.modo,
      limite: limite === null ? null : new Date(limite).toISOString(),
      aguardando: !this.liberto() && limite !== null && agora >= limite,
      ultimoResultado: this.ultimoJogado(),
      ocupado: this.emAndamento,
      dadosDe: this.d.dadosDe?.() ?? null,
      baixadoEm: this.baixadoEm === null ? null : new Date(this.baixadoEm).toISOString(),
      dadosFrescos: this.dadosFrescos(),
    };
  }

  private ultimoJogado(): string | null {
    let ultimo: number | null = null;
    for (const c of ["brasileirao-a", "brasileirao-b", "copa-do-brasil", "libertadores", "sulamericana"] as const) {
      for (const m of this.d.fonte.matchesOf(c)) if (m.status === "finished") ultimo = Math.max(ultimo ?? 0, kickoffTime(m));
    }
    return ultimo === null ? null : new Date(ultimo).toISOString();
  }

  // ---------- pedidos ----------

  async pedir(p: Pedido): Promise<RespostaDoRelogio> {
    switch (p.acao) {
      case "agora":
        return this.alcancarAgora();
      case "dia":
        return this.saltar((agora) => ({ alvo: agora + DIA }), "1 dia");
      case "rodada":
        return this.saltar((agora) => this.fimDaProximaRodada(agora), "até a próxima rodada");
      case "ate":
        return this.saltarAteData(p.data);
      case "atualizar":
        return this.atualizar();
      case "pausar":
        return this.pausar();
      case "tempo-real":
        return this.ligarTempoReal();
    }
  }

  private resposta(avancou: boolean, mensagem: string): RespostaDoRelogio {
    return { estado: this.estado(), avancou, mensagem };
  }

  private mensagemDeEspera(): string {
    const ultimo = this.ultimoJogado();
    return `aguardando resultados reais${ultimo ? ` (último resultado em ${ultimo.slice(0, 10)})` : ""}`;
  }

  /**
   * O fechamento da próxima rodada do Brasileirão: o que vem primeiro no tempo (a rodada em curso, se o relógio estiver no meio
   * dela). O fim de uma rodada é o fim do último jogo dentro da janela dela (7 dias do primeiro jogo): jogo remarcado para
   * semanas depois não a segura, senão uma rodada antiga com jogo remarcado viraria o alvo e o salto passaria por rodadas
   * inteiras (defeito do item 18).
   */
  private fimDaProximaRodada(agora: number): { alvo: number; rodada: number } {
    const jogos = new Map<number, Match[]>();
    for (const m of this.d.fonte.matchesOf("brasileirao-a")) {
      if (m.round === undefined || m.postponed || m.status === "cancelled") continue;
      jogos.set(m.round, [...(jogos.get(m.round) ?? []), m]);
    }
    const fins: Array<{ rodada: number; fim: number }> = [];
    for (const [rodada, ms] of jogos) {
      const janela = Math.min(...ms.map(kickoffTime)) + JANELA_DA_RODADA;
      const fim = Math.max(...ms.filter((m) => kickoffTime(m) <= janela).map(finishTime));
      if (fim > agora) fins.push({ rodada, fim });
    }
    fins.sort((a, b) => a.fim - b.fim || a.rodada - b.rodada);
    if (fins.length === 0) throw new DomainError("sem_proxima_rodada", 422, "não há próxima rodada do Brasileirão nos dados");
    return { alvo: fins[0]!.fim + MARGEM_DO_FECHAMENTO, rodada: fins[0]!.rodada }; // o fechamento da rodada já rodou
  }

  private async saltarAteData(data: string): Promise<RespostaDoRelogio> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || Number.isNaN(Date.parse(`${data}T00:00:00-03:00`))) {
      throw new DomainError("data_invalida", 422, "informe a data no formato AAAA-MM-DD");
    }
    const alvo = Date.parse(`${data}T00:00:00-03:00`);
    const agora = this.d.clock.now().getTime();
    if (alvo <= agora) throw new DomainError("data_no_passado", 422, `a data ${data} já passou no relógio da partida`);
    const limite = this.limite();
    if (limite !== null && alvo > limite) {
      throw new DomainError("alem_do_limite", 422, `a data ${data} passa do último resultado real (${new Date(limite).toISOString().slice(0, 10)}): peça "atualizar" quando houver mais jogos`);
    }
    return this.saltar(() => ({ alvo }), `até ${data}`);
  }

  /**
   * Um salto: paradas de 180 minutos até o alvo (ou até o limite), um pedido por vez. Se o relógio estava em tempo real, ele
   * congela durante o salto e volta a correr do instante onde o salto terminou.
   */
  private async saltar(calcularAlvo: (agora: number) => { alvo: number; rodada?: number }, rotulo: string): Promise<RespostaDoRelogio> {
    if (this.emAndamento) throw ocupado();
    this.emAndamento = rotulo;
    this.interromper = false;
    let terminou!: () => void;
    this.fimDoSalto = new Promise<void>((ok) => (terminou = ok));
    try {
      const estavaEmTempoReal = this.modo === "tempo-real";
      this.geracao++; // o laço do tempo real para de agendar
      this.cancelarEspera?.();
      await this.paradaAtual;
      this.d.clock.congelar();
      try {
        const inicio = this.d.clock.now().getTime();
        const limite = this.limite();
        if (limite !== null && inicio >= limite) return this.resposta(false, this.liberto() ? "o relógio já está na hora real" : this.mensagemDeEspera());
        const pedido = calcularAlvo(inicio);
        let alvo = pedido.alvo;
        let cortou = false;
        if (limite !== null && alvo > limite) {
          alvo = limite;
          cortou = true;
        }
        // enquanto o salto corre, a tela mostra para onde ele vai (data de Brasília e, na rodada, qual)
        this.emAndamento = `avançando até ${diaDeBrasilia(alvo)}${pedido.rodada !== undefined && !cortou ? `, fim da rodada ${pedido.rodada}` : ""}`;
        while (this.d.clock.now().getTime() < alvo && !this.interromper) {
          await this.d.condutor.paradaUnica({ passoMs: PASSO_SALTO, alvo });
          await this.d.salvar(this.d.clock.now());
        }
        this.ultimaParada = this.d.clock.now().getTime();
        if (this.interromper) return this.resposta(this.d.clock.now().getTime() > inicio, `salto interrompido em ${this.d.clock.now().toISOString()}: pausado`);
        return this.resposta(true, cortou ? `avancei até o último resultado real. ${this.mensagemDeEspera()}` : `avancei: ${rotulo}`);
      } finally {
        if (this.interromper) {
          this.modo = "pausado"; // pausar com o salto andando: fica parado onde o salto chegou
        } else if (estavaEmTempoReal && !this.noLimite()) {
          this.d.clock.correr();
          this.iniciarLaco();
        } else if (estavaEmTempoReal) {
          this.modo = "pausado";
        }
      }
    } finally {
      this.emAndamento = null;
      this.interromper = false;
      terminou();
    }
  }

  private noLimite(): boolean {
    // seguindo a hora real, o relógio nunca "chega ao limite": ele anda junto com ela
    if (this.liberto()) return false;
    const limite = this.limite();
    return limite !== null && this.d.clock.now().getTime() >= limite;
  }

  // ---------- tempo real ----------

  async ligarTempoReal(): Promise<RespostaDoRelogio> {
    if (this.emAndamento) throw ocupado();
    if (this.noLimite()) return this.resposta(false, this.mensagemDeEspera());
    if (this.modo === "tempo-real") return this.resposta(false, "o relógio já está em tempo real");
    this.modo = "tempo-real";
    this.ultimaParada = this.d.clock.now().getTime();
    this.d.clock.correr();
    this.iniciarLaco();
    return this.resposta(false, "tempo real ligado: um minuto de verdade é um minuto do jogo");
  }

  async pausar(): Promise<RespostaDoRelogio> {
    if (this.emAndamento === "atualizar") throw ocupado();
    if (this.emAndamento) {
      // um salto andando: ele para ao fim da parada atual (cada parada leva até 180 minutos do jogo) e o relógio fica onde chegou
      this.interromper = true;
      await this.fimDoSalto;
      return this.resposta(false, `salto interrompido; pausado em ${this.d.clock.now().toISOString()}`);
    }
    this.geracao++;
    this.cancelarEspera?.();
    await this.paradaAtual;
    this.d.clock.congelar();
    this.modo = "pausado";
    await this.d.salvar(this.d.clock.now());
    return this.resposta(false, "pausado");
  }

  private iniciarLaco(): void {
    if (this.d.laco === false) return;
    const geracao = ++this.geracao;
    void (async () => {
      while (this.geracao === geracao && this.modo === "tempo-real") {
        const prox = this.d.condutor.proxima(new Date(this.ultimaParada), PASSO_TEMPO_REAL, this.alvoDasParadas());
        const espera = prox.em.getTime() - this.d.clock.now().getTime();
        if (espera > 0) await this.esperar(espera);
        if (this.geracao !== geracao || this.modo !== "tempo-real") return;
        await this.tique();
      }
    })().catch((erro) => {
      this.modo = "pausado";
      this.d.clock.congelar();
      console.error(`partida: o tempo real parou: ${(erro as Error).message}`);
    });
  }

  /** O limite que corta as paradas do tempo real: só o dos jogos; seguindo a hora real, nenhum (o relógio não passa dela por construção). */
  private alvoDasParadas(): number | undefined {
    return this.liberto() ? undefined : (this.limite() ?? undefined);
  }

  private esperar(ms: number): Promise<void> {
    if (this.d.esperar) return this.d.esperar(ms);
    return new Promise((ok) => {
      const t = setTimeout(ok, ms);
      this.cancelarEspera = () => {
        clearTimeout(t);
        ok();
      };
    });
  }

  /**
   * Faz as paradas do tempo real que já passaram no relógio (uma a cada 5 minutos do jogo e nos instantes de produção) e, se o
   * relógio chegou ao limite, pausa com "aguardando resultados reais". O laço chama a cada parada; os testes chamam à mão.
   */
  async tique(): Promise<void> {
    if (this.modo !== "tempo-real" || this.emAndamento) return;
    const feita = (async () => {
      // perto da hora real, os dados são baixados sozinhos a cada 5 minutos, antes das paradas (item 23)
      if (this.devoBaixar()) await this.baixarSozinho();
      for (;;) {
        const limite = this.limite();
        if (!this.liberto() && limite !== null && this.ultimaParada >= limite) break;
        const prox = this.d.condutor.proxima(new Date(this.ultimaParada), PASSO_TEMPO_REAL, this.alvoDasParadas());
        if (prox.em.getTime() > this.d.clock.now().getTime()) return;
        await this.d.condutor.paradaEm(prox.em, prox.motivo);
        this.ultimaParada = prox.em.getTime();
        await this.d.salvar(this.d.clock.now());
      }
      // chegou ao limite: o tempo real para até haver resultados novos
      this.d.clock.congelar();
      this.d.clock.set(new Date(this.ultimaParada));
      this.modo = "pausado";
      await this.d.salvar(this.d.clock.now());
    })();
    this.paradaAtual = feita;
    await feita;
  }

  // ---------- atualizar ----------

  /** Baixa os dados da ESPN, troca a foto dos jogos se mudou e anota a hora da baixa (os dados valem como frescos por 12 minutos). */
  private async baixar(): Promise<Awaited<ReturnType<DepsDoRelogio["atualizar"]>>> {
    const r = await this.d.atualizar();
    this.baixadoEm = this.agoraReal();
    if (r.mudaram.length > 0) {
      this.d.fonte.trocarDados(paraMemoria(r.fotos));
      this.d.condutor.recalcularInstantes();
    }
    return r;
  }

  /** É hora da baixa automática: tempo real, perto da hora real e a última baixa tem 5 minutos (menos uma folga). */
  private devoBaixar(): boolean {
    if (this.modo !== "tempo-real") return false;
    const agora = this.agoraReal();
    if (agora - this.d.clock.now().getTime() > PERTO_DA_HORA_REAL) return false;
    return this.baixadoEm === null || agora - this.baixadoEm >= BAIXA_AUTOMATICA - 30_000;
  }

  /** A baixa automática: se a ESPN falhar, só registra; os dados deixam de ser frescos e o relógio volta ao limite dos jogos. */
  private async baixarSozinho(): Promise<void> {
    try {
      await this.baixar();
    } catch (erro) {
      console.error(`partida: não consegui baixar os dados da ESPN sozinha: ${(erro as Error).message}`);
    }
  }

  /**
   * "Agora" (item 23): baixa os dados, salta até a hora real (em quantos saltos precisar, o último é curto) e liga o tempo real,
   * que daí em diante acompanha a hora de verdade. É o jeito de deixar o relógio pronto para jogar durante os jogos.
   */
  private async alcancarAgora(): Promise<RespostaDoRelogio> {
    if (this.emAndamento) throw ocupado();
    await this.atualizar(); // dados frescos: sem isso o limite seria o do último jogo terminado
    let avancou = false;
    let interrompido = false;
    for (let rodada = 0; rodada < 4 && this.agoraReal() - this.d.clock.now().getTime() > ATRASO_ACEITO; rodada++) {
      const r = await this.saltar(() => ({ alvo: this.agoraReal() }), "até a hora real");
      avancou ||= r.avancou;
      if (r.mensagem.startsWith("salto interrompido")) interrompido = true;
      if (interrompido || !r.avancou) break;
    }
    if (interrompido) return this.resposta(avancou, `interrompido em ${this.d.clock.now().toISOString()}: pausado`);
    if (this.modo !== "tempo-real") {
      const t = await this.ligarTempoReal();
      return this.resposta(avancou, `na hora real (${this.d.clock.now().toISOString()}). ${t.mensagem}`);
    }
    return this.resposta(avancou, "na hora real, em tempo real");
  }

  /** Baixa os dados de novo; se vieram jogos novos o limite sobe. Falha de rede deixa tudo como estava. */
  private async atualizar(): Promise<RespostaDoRelogio> {
    if (this.emAndamento) throw ocupado();
    this.emAndamento = "atualizar";
    try {
      await this.paradaAtual;
      let r;
      try {
        r = await this.baixar();
      } catch (erro) {
        throw new DomainError("atualizacao_falhou", 502, (erro as Error).message);
      }
      if (r.mudaram.length === 0) return this.resposta(false, "a ESPN não trouxe nada de novo; nada mudou");
      const sobe = (r.limiteDepois ?? 0) > (r.limiteAntes ?? 0);
      return this.resposta(false, sobe ? `dados novos (${r.mudaram.join(", ")}): o limite subiu` : `dados novos (${r.mudaram.join(", ")}), mas o limite não mudou`);
    } finally {
      this.emAndamento = null;
    }
  }
}
