import WebSocket from "ws";
import { Histograma, type ResumoHistograma } from "./medidores.js";

/**
 * As conexões WebSocket da carga (T16): cada uma entra com o token, assina `prices`, `club:<ticker>` e `me`, e mede o atraso
 * de cada evento pelo `at` do envelope (o instante da publicação no relógio da API) contra o relógio simulado de agora. O relógio
 * da API anda na velocidade real, com um deslocamento constante para o `Date.now()` do gerador: a conta é exata na mesma máquina.
 * Se a conexão cai sem o gerador pedir, ela reabre com recuo e sorteio (o comportamento do site) e conta o tempo da retomada.
 */

export interface OpcoesConexoes {
  wsUrl: string;
  /** O `Origin` aceito pela API (`WEB_ORIGIN`). */
  origem: string;
  /** Quanto o relógio da API está à frente do `Date.now()` do gerador. */
  deslocamentoMs: number;
}

export interface AlvoDeConexao {
  token: string;
  canais: string[];
}

export interface EstatisticasDasConexoes {
  abertas: number;
  tentativas: number;
  falhas: number;
  fechadasPeloServidor: number;
  eventos: number;
  buracosDeSeq: number;
  atraso: Record<string, ResumoHistograma>;
}

class Conexao {
  socket?: WebSocket;
  pronta = false;
  seq = new Map<string, number>();
  encerrada = false;
  /** Instante em que a conexão caiu sem pedido, para medir a retomada. */
  caiuEm: number | null = null;

  constructor(
    private readonly pool: PoolDeConexoes,
    readonly alvo: AlvoDeConexao,
  ) {}

  abrir(): void {
    if (this.encerrada) return;
    this.pool.estat.tentativas++;
    const socket = new WebSocket(this.pool.opcoes.wsUrl, { origin: this.pool.opcoes.origem });
    this.socket = socket;
    socket.on("open", () => socket.send(JSON.stringify({ type: "auth", token: this.alvo.token })));
    socket.on("message", (bruto) => this.receber(bruto.toString()));
    socket.on("error", () => {
      this.pool.estat.falhas++;
    });
    socket.on("close", () => {
      const estavaPronta = this.pronta;
      this.pronta = false;
      if (estavaPronta) this.pool.abertas--;
      if (this.encerrada) return;
      if (estavaPronta) this.pool.estat.fechadasPeloServidor++;
      this.caiuEm ??= Date.now();
      this.pool.agendarReabertura(this);
    });
  }

  private receber(texto: string): void {
    const msg = JSON.parse(texto) as { type: string; channel: string; seq: number; at: string; data?: unknown };
    if (msg.channel === "system") {
      if (msg.type === "auth.ok") void this.assinar();
      return;
    }
    const antes = this.seq.get(msg.channel);
    if (antes !== undefined && msg.seq > antes + 1) this.pool.estat.buracosDeSeq++;
    if (antes === undefined || msg.seq > antes) this.seq.set(msg.channel, msg.seq);
    this.pool.estat.eventos++;
    const atraso = Date.now() + this.pool.opcoes.deslocamentoMs - Date.parse(msg.at);
    this.pool.registrarAtraso(msg.type, atraso);
  }

  /** O servidor aceita 20 mensagens por segundo por conexão: as assinaturas saem espaçadas. */
  private async assinar(): Promise<void> {
    for (const canal of this.alvo.canais) {
      if (this.encerrada || this.socket?.readyState !== WebSocket.OPEN) return;
      this.socket.send(JSON.stringify({ type: "subscribe", channel: canal }));
      await new Promise((r) => setTimeout(r, 60));
    }
    if (this.encerrada || this.socket?.readyState !== WebSocket.OPEN) return;
    this.pronta = true;
    this.pool.abertas++;
    if (this.caiuEm !== null) {
      this.pool.retomadas.registrar(Date.now() - this.caiuEm);
      this.caiuEm = null;
    }
  }

  fechar(): void {
    this.encerrada = true;
    this.socket?.close();
  }
}

export class PoolDeConexoes {
  readonly estat: EstatisticasDasConexoes = { abertas: 0, tentativas: 0, falhas: 0, fechadasPeloServidor: 0, eventos: 0, buracosDeSeq: 0, atraso: {} };
  abertas = 0;
  /** Quanto cada conexão que caiu levou para voltar (ms). */
  readonly retomadas = new Histograma();
  private readonly atrasos = new Map<string, Histograma>();
  private readonly conexoes: Conexao[] = [];

  constructor(readonly opcoes: OpcoesConexoes) {}

  registrarAtraso(tipo: string, ms: number): void {
    let h = this.atrasos.get(tipo);
    if (!h) this.atrasos.set(tipo, (h = new Histograma()));
    h.registrar(ms);
  }

  agendarReabertura(c: Conexao): void {
    // recuo de 0,5 a 5 s com sorteio, como o cliente do site (para não reconectar todas de uma vez)
    setTimeout(() => c.abrir(), 500 + Math.random() * 4500).unref?.();
  }

  /** Abre as conexões, no máximo `porSegundo` novas por segundo (o servidor também tem limite de entrada). */
  async abrir(alvos: AlvoDeConexao[], porSegundo = 200): Promise<void> {
    const intervalo = 1000 / porSegundo;
    for (const alvo of alvos) {
      const c = new Conexao(this, alvo);
      this.conexoes.push(c);
      c.abrir();
      await new Promise((r) => setTimeout(r, intervalo));
    }
  }

  /** Espera até `n` conexões prontas (ou o prazo); devolve quantas estavam. */
  async esperarProntas(n: number, prazoMs: number): Promise<number> {
    const limite = Date.now() + prazoMs;
    while (this.abertas < n && Date.now() < limite) await new Promise((r) => setTimeout(r, 100));
    return this.abertas;
  }

  estatisticas(): EstatisticasDasConexoes {
    return { ...this.estat, abertas: this.abertas, atraso: Object.fromEntries([...this.atrasos].map(([k, h]) => [k, h.resumo()])) };
  }

  /** Zera o que se mede (atrasos e eventos), sem derrubar as conexões. */
  zerarMedidas(): void {
    this.atrasos.clear();
    this.estat.eventos = 0;
    this.estat.buracosDeSeq = 0;
  }

  fecharTodas(): void {
    for (const c of this.conexoes) c.fechar();
  }
}
