import { performance } from "node:perf_hooks";
import { Histograma, type ResumoHistograma } from "./medidores.js";

/**
 * O tráfego da carga (T16): ordens limitadas perto do preço, ordens a mercado, cancelamentos e leituras de livro e carteira,
 * com metade das ordens no clube "quente". O ritmo é de malha aberta: as chamadas saem na hora marcada, sem esperar a
 * resposta da anterior (é isso que mostra a fila crescer quando o servidor não dá conta). Cada jogador manda no máximo uma
 * ordem por segundo, e o servidor limita 60 ordens por minuto por pessoa, então o ritmo máximo é o número de jogadores
 * por segundo.
 */

export interface JogadorDeCarga {
  token: string;
}

export interface PerfilDeTrafego {
  tickers: string[];
  /** Metade das ordens, por padrão, vai para este clube. */
  clubeQuente: string;
  fracaoQuente: number;
  /** Preço de referência (centavos) e a dispersão das ordens limitadas ao redor dele (±). */
  preco: number;
  dispersao: number;
  /** Fração das ordens enviadas a mercado e dos pedidos de cancelamento. */
  fracaoMercado: number;
  fracaoCancelamento: number;
  /** Leituras (livro, carteira, ordens abertas) por ordem enviada. */
  leiturasPorOrdem: number;
  /** Só o clube quente (o degrau do limite por clube). */
  soQuente?: boolean;
}

export const PERFIL_PADRAO: Omit<PerfilDeTrafego, "tickers" | "clubeQuente"> = {
  fracaoQuente: 0.5,
  preco: 4000,
  dispersao: 0.06,
  fracaoMercado: 0.08,
  fracaoCancelamento: 0.1,
  leiturasPorOrdem: 0.5,
};

export interface Degrau {
  ordensPorSegundo: number;
  segundos: number;
}

export interface ResultadoDoDegrau {
  pedidoPorSegundo: number;
  /** Quantas ordens saíram de fato por segundo (menos que o pedido se o gerador estourou o limite de chamadas em voo). */
  enviadoPorSegundo: number;
  segundos: number;
  ordens: number;
  descartadasPorFila: number;
  status: Record<string, number>;
  erros5xx: string[];
  latencia: Record<string, ResumoHistograma>;
  /** Chamadas ainda em voo no fim do degrau (fila no servidor). */
  emVoo: number;
}

const LIMITE_EM_VOO = 3000;

export class Trafego {
  private proximo = 0;
  private readonly ultimasOrdens = new Map<number, number[]>();
  private emVoo = 0;
  private semente = 1;

  constructor(
    private readonly apiUrl: string,
    private readonly jogadores: JogadorDeCarga[],
    private readonly perfil: PerfilDeTrafego,
  ) {}

  private sorteio(): number {
    // mulberry32: o mesmo sorteio em toda execução, para os relatórios se compararem
    let t = (this.semente = (this.semente + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  private ticker(): string {
    const p = this.perfil;
    if (p.soQuente || this.sorteio() < p.fracaoQuente) return p.clubeQuente;
    const outros = p.tickers.filter((t) => t !== p.clubeQuente);
    return outros.length === 0 ? p.clubeQuente : outros[Math.floor(this.sorteio() * outros.length)]!;
  }

  /** Roda um degrau do ritmo pedido e devolve o resultado. As chamadas em voo no fim contam em `emVoo`. */
  async rodar(degrau: Degrau): Promise<ResultadoDoDegrau> {
    const r: ResultadoDoDegrau = {
      pedidoPorSegundo: degrau.ordensPorSegundo,
      enviadoPorSegundo: 0,
      segundos: degrau.segundos,
      ordens: 0,
      descartadasPorFila: 0,
      status: {},
      erros5xx: [],
      latencia: {},
      emVoo: 0,
    };
    const histogramas = new Map<string, Histograma>();
    const pendentes = new Set<Promise<void>>();
    const t0 = performance.now();
    const total = degrau.ordensPorSegundo * degrau.segundos;
    let marcadas = 0;
    while (marcadas < total) {
      const devidas = Math.min(total, Math.floor(((performance.now() - t0) / 1000) * degrau.ordensPorSegundo) + 1);
      while (marcadas < devidas) {
        marcadas++;
        if (this.emVoo >= LIMITE_EM_VOO) {
          r.descartadasPorFila++;
          continue;
        }
        const p = this.uma(r, histogramas);
        pendentes.add(p);
        void p.finally(() => pendentes.delete(p));
      }
      await new Promise((ok) => setTimeout(ok, 5));
    }
    const duracao = (performance.now() - t0) / 1000;
    r.emVoo = pendentes.size;
    await Promise.race([Promise.all(pendentes), new Promise((ok) => setTimeout(ok, 30_000))]);
    r.enviadoPorSegundo = Math.round((r.ordens / duracao) * 10) / 10;
    r.latencia = Object.fromEntries([...histogramas].map(([k, h]) => [k, h.resumo()]));
    return r;
  }

  private async uma(r: ResultadoDoDegrau, histogramas: Map<string, Histograma>): Promise<void> {
    const indice = this.proximo++ % this.jogadores.length;
    const jogador = this.jogadores[indice]!;
    const x = this.sorteio();
    const p = this.perfil;
    const ticker = this.ticker();
    this.emVoo++;
    try {
      if (x < p.fracaoCancelamento) {
        const id = this.ultimasOrdens.get(indice)?.pop();
        if (id !== undefined) {
          await this.chamar(r, histogramas, "cancelar", "DELETE", `/orders/${id}`, jogador.token);
          return;
        }
      }
      r.ordens++;
      const compra = this.sorteio() < 0.5;
      const quantidade = 1 + Math.floor(this.sorteio() * 10);
      const corpo =
        x < p.fracaoCancelamento + p.fracaoMercado
          ? { ticker, side: compra ? "buy" : "sell", type: "market", quantity: Math.min(quantidade, 5) }
          : {
              ticker,
              side: compra ? "buy" : "sell",
              type: "limit",
              quantity: quantidade,
              limitPrice: Math.round((p.preco * (1 + (this.sorteio() * 2 - 1) * p.dispersao)) / 10) * 10,
            };
      const resposta = await this.chamar(r, histogramas, corpo.type === "market" ? "ordem_mercado" : "ordem_limite", "POST", "/orders", jogador.token, corpo);
      const id = (resposta as { order?: { id: number; status: string } } | null)?.order;
      if (id && id.status === "open") {
        const lista = this.ultimasOrdens.get(indice) ?? [];
        lista.push(id.id);
        if (lista.length > 5) lista.shift();
        this.ultimasOrdens.set(indice, lista);
      }
      // as leituras de um jogador logado: o livro do clube, a carteira e as ordens abertas
      let leituras = p.leiturasPorOrdem;
      while (leituras > 0 && this.sorteio() < Math.min(1, leituras)) {
        leituras -= 1;
        const y = this.sorteio();
        if (y < 0.5) await this.chamar(r, histogramas, "ler_livro", "GET", `/clubs/${ticker}/book`, jogador.token);
        else if (y < 0.85) await this.chamar(r, histogramas, "ler_carteira", "GET", "/portfolio", jogador.token);
        else await this.chamar(r, histogramas, "ler_ordens", "GET", "/orders?status=open", jogador.token);
      }
    } finally {
      this.emVoo--;
    }
  }

  private async chamar(
    r: ResultadoDoDegrau,
    histogramas: Map<string, Histograma>,
    nome: string,
    metodo: string,
    caminho: string,
    token: string,
    corpo?: object,
  ): Promise<unknown> {
    const inicio = performance.now();
    try {
      const res = await fetch(`${this.apiUrl}${caminho}`, {
        method: metodo,
        headers: { authorization: `Bearer ${token}`, ...(corpo ? { "content-type": "application/json" } : {}) },
        body: corpo ? JSON.stringify(corpo) : undefined,
      });
      const texto = await res.text();
      let h = histogramas.get(nome);
      if (!h) histogramas.set(nome, (h = new Histograma()));
      h.registrar(performance.now() - inicio);
      const chave = res.status < 300 ? "2xx" : res.status >= 500 ? "5xx" : String(res.status);
      r.status[chave] = (r.status[chave] ?? 0) + 1;
      if (res.status >= 500 && r.erros5xx.length < 10) r.erros5xx.push(`${metodo} ${caminho} → ${res.status}: ${texto.slice(0, 160)}`);
      if (res.status >= 300) {
        const codigo = (JSON.parse(texto || "null") as { code?: string } | null)?.code;
        if (codigo) r.status[`${res.status}:${codigo}`] = (r.status[`${res.status}:${codigo}`] ?? 0) + 1;
        return null;
      }
      return texto ? JSON.parse(texto) : null;
    } catch (erro) {
      r.status.rede = (r.status.rede ?? 0) + 1;
      if (r.erros5xx.length < 10) r.erros5xx.push(`${metodo} ${caminho} → ${(erro as Error).message}`);
      return null;
    }
  }
}
