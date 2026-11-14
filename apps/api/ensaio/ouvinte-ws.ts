import WebSocket from "ws";
import type { BookEvent } from "@futbolsa/contracts";

/** O que o ouvinte guarda de um canal: o último evento de cada tipo e se a numeração (`seq`) seguiu sem buracos. */
export interface EstadoDoCanal {
  seq: number;
  buracos: number;
  eventos: number;
  ultimoLivro: BookEvent | null;
}

/**
 * Cliente de WebSocket do ensaio (T7): entra com o token, assina canais e monta o livro só com os eventos, para o jogador
 * de teste conferir que ele é igual ao da rota REST (`seq` do canal, F6).
 */
export class OuvinteWs {
  readonly canais = new Map<string, EstadoDoCanal>();
  readonly mensagensDoSistema: Array<{ type: string; data: unknown }> = [];
  private socket!: WebSocket;
  private aberto = false;
  /** Quando o servidor fecha a conexão: código, motivo e o instante simulado não importam aqui, só o fato. */
  fechadoCom: { codigo: number; motivo: string } | null = null;

  constructor(
    private readonly url: string,
    private readonly origem: string,
  ) {}

  async conectar(token: string): Promise<void> {
    this.socket = new WebSocket(this.url, { origin: this.origem });
    this.socket.on("close", (codigo, motivo) => (this.fechadoCom = { codigo, motivo: motivo.toString() }));
    this.socket.on("message", (bruto) => this.receber(JSON.parse(bruto.toString())));
    await new Promise<void>((ok, falha) => {
      this.socket.once("open", ok);
      this.socket.once("error", falha);
    });
    this.aberto = true;
    this.socket.send(JSON.stringify({ type: "auth", token }));
    await this.esperarSistema("auth.ok");
  }

  /** Assina um canal; o servidor aceita no máximo 20 mensagens por segundo por conexão, então o ensaio espaça. */
  async assinar(canal: string): Promise<void> {
    this.socket.send(JSON.stringify({ type: "subscribe", channel: canal }));
    await new Promise((r) => setTimeout(r, 70));
  }

  private receber(msg: { type: string; channel: string; seq: number; data: unknown }): void {
    if (msg.channel === "system") {
      this.mensagensDoSistema.push({ type: msg.type, data: msg.data });
      return;
    }
    const estado = this.canais.get(msg.channel) ?? { seq: 0, buracos: 0, eventos: 0, ultimoLivro: null };
    // `seq` começa em 1 e cresce de 1 em 1; o primeiro evento depois de assinar pode vir de uma retomada
    if (estado.seq !== 0 && msg.seq > estado.seq + 1) estado.buracos++;
    if (msg.seq > estado.seq) estado.seq = msg.seq;
    estado.eventos++;
    if (msg.type === "book") estado.ultimoLivro = msg.data as BookEvent;
    this.canais.set(msg.channel, estado);
  }

  private async esperarSistema(tipo: string, ms = 5000): Promise<void> {
    const limite = Date.now() + ms;
    while (Date.now() < limite) {
      if (this.mensagensDoSistema.some((m) => m.type === tipo)) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`o WebSocket não respondeu ${tipo} em ${ms} ms (recebeu: ${this.mensagensDoSistema.map((m) => m.type).join(", ") || "nada"})`);
  }

  fechar(): void {
    if (this.aberto) this.socket.close();
    this.aberto = false;
  }
}
