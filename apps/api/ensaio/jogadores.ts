import { randomUUID } from "node:crypto";
import type { BookView } from "@futbolsa/contracts";
import { bearer, tokenFor } from "../test/support/auth.js";
import type { Carregado } from "./carregar.js";
import type { Parada } from "./condutor.js";
import { OuvinteWs } from "./ouvinte-ws.js";
import type { ServidorEnsaio } from "./servidor.js";

/**
 * Jogadores de teste (T7): de 6 a 10 pessoas que usam as rotas e o WebSocket de verdade (login falso só no verificador de
 * token): cadastro, ofertas no IPO, compras e vendas, cancelamentos, carteira e ranking. Um deles (o "ouvinte") confere, uma
 * vez por dia, que o livro montado só com os eventos do WebSocket é igual ao da rota REST.
 */

export interface ResumoDosJogadores {
  chamadas: number;
  porStatus: Record<string, number>;
  /** Respostas 5xx: o ensaio falha se houver alguma. */
  erros5xx: string[];
  /** Recusas de regra por código (`price_out_of_band`, `insufficient_cash`...). */
  recusas: Record<string, number>;
  ofertasNoIpo: number;
  ordens: number;
  cancelamentos: number;
  conferenciasDeLivro: number;
}

export class Jogador {
  readonly subject = randomUUID();
  readonly email: string;
  ws: OuvinteWs | null = null;
  constructor(
    readonly apelido: string,
    private readonly servidor: ServidorEnsaio,
    private readonly resumo: ResumoDosJogadores,
  ) {
    this.email = `${apelido}@exemplo.com`;
  }

  /** `expiresIn` em segundos: o WebSocket fecha quando o token vence no relógio simulado, então a conexão longa usa um token longo. */
  async token(expiresIn?: number): Promise<string> {
    return tokenFor({ subject: this.subject, email: this.email, at: this.servidor.clock.now(), expiresIn });
  }

  /** Uma chamada HTTP de verdade (pela porta da API), contada por status. */
  async http<T = unknown>(method: string, url: string, payload?: object): Promise<{ status: number; corpo: T }> {
    const res = await fetch(`${this.servidor.url}${url}`, {
      method,
      headers: { ...bearer(await this.token()), ...(payload ? { "content-type": "application/json" } : {}) },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    const texto = await res.text();
    const corpo = (texto ? JSON.parse(texto) : null) as T;
    this.resumo.chamadas++;
    this.resumo.porStatus[res.status] = (this.resumo.porStatus[res.status] ?? 0) + 1;
    if (res.status >= 500) this.resumo.erros5xx.push(`${method} ${url} → ${res.status}: ${texto.slice(0, 200)}`);
    else if (res.status >= 400) {
      const codigo = (corpo as { code?: string } | null)?.code ?? String(res.status);
      this.resumo.recusas[codigo] = (this.resumo.recusas[codigo] ?? 0) + 1;
    }
    return { status: res.status, corpo };
  }

  async cadastrar(): Promise<void> {
    const r = await this.http("POST", "/me", { nickname: this.apelido, acceptTerms: true });
    if (r.status >= 300) throw new Error(`cadastro de ${this.apelido} → ${r.status}: ${JSON.stringify(r.corpo)}`);
  }

  async livro(ticker: string): Promise<BookView> {
    return (await this.http<BookView>("GET", `/clubs/${ticker}/book`)).corpo;
  }

  async conectarWs(tickers: readonly string[]): Promise<void> {
    const ws = new OuvinteWs(this.servidor.url.replace("http", "ws") + "/ws", process.env.WEB_ORIGIN!);
    await ws.conectar(await this.token(400 * 86_400));
    for (const t of tickers) await ws.assinar(`club:${t}`);
    await ws.assinar("me");
    this.ws = ws;
  }
}

export interface OpcoesJogadores {
  quantos?: number;
  sorteio: () => number;
}

export class Jogadores {
  readonly lista: Jogador[] = [];
  /** Conta só para o WebSocket e a conferência dos livros: o limite de 300 chamadas por minuto é por pessoa e em tempo real. */
  observador!: Jogador;
  readonly resumo: ResumoDosJogadores = { chamadas: 0, porStatus: {}, erros5xx: [], recusas: {}, ofertasNoIpo: 0, ordens: 0, cancelamentos: 0, conferenciasDeLivro: 0 };
  private readonly sorteio: () => number;

  constructor(
    private readonly servidor: ServidorEnsaio,
    private readonly carga: Carregado,
    private readonly opcoes: OpcoesJogadores,
  ) {
    this.sorteio = opcoes.sorteio;
  }

  private escolher<T>(itens: readonly T[]): T {
    return itens[Math.floor(this.sorteio() * itens.length)]!;
  }

  /** Cadastra os jogadores (6 por padrão) e conecta o ouvinte do WebSocket nos clubes dados. */
  async cadastrar(tickersDoOuvinte: readonly string[]): Promise<void> {
    const quantos = this.opcoes.quantos ?? 6;
    for (let i = 0; i < quantos; i++) this.lista.push(new Jogador(`jogador_${i + 1}`, this.servidor, this.resumo));
    this.observador = new Jogador("observador", this.servidor, this.resumo);
    // o jogo é só com convite (Conta e login): o admin libera os e-mails antes do cadastro
    const convite = await this.servidor.app.inject({
      method: "POST",
      url: "/admin/invites",
      payload: { emails: [...this.lista, this.observador].map((j) => j.email) },
      headers: await this.carga.admin.auth(),
    });
    if (convite.statusCode >= 300) throw new Error(`convites → ${convite.statusCode}: ${convite.body}`);
    for (const jogador of [...this.lista, this.observador]) await jogador.cadastrar();
    await this.observador.conectarWs(tickersDoOuvinte);
  }

  /** O que cada jogador faz numa parada: ofertas no IPO ou ordens no mercado, e de vez em quando cancela. */
  async agir(_parada: Parada): Promise<void> {
    const status = await this.statusDaTemporada();
    for (const jogador of this.lista) {
      if (this.sorteio() > 0.35) continue; // nem todo mundo age em toda parada
      if (status === "ipo_open") await this.ofertar(jogador);
      else if (status === "trading") await this.negociar(jogador);
    }
  }

  private async statusDaTemporada(): Promise<string> {
    const res = await fetch(`${this.servidor.url}/season`);
    const corpo = (await res.json()) as { status?: string; season?: { status?: string } | null };
    return corpo.season?.status ?? corpo.status ?? "";
  }

  private async ofertar(jogador: Jogador): Promise<void> {
    const ticker = this.escolher(this.carga.tickers);
    const painel = await jogador.http<{ clubs?: Array<{ ticker: string; band?: { ceiling: number } | null }> }>("GET", "/ipo");
    const clube = painel.corpo?.clubs?.find((c) => c.ticker === ticker);
    const teto = clube?.band?.ceiling ?? 5000;
    const acao = this.sorteio();
    if (acao < 0.15) {
      const r = await jogador.http("DELETE", `/ipo/bids/${ticker}`);
      if (r.status < 300) this.resumo.cancelamentos++;
      return;
    }
    const quantidade = 1 + Math.floor(this.sorteio() * 40);
    const r = await jogador.http("PUT", `/ipo/bids/${ticker}`, { quantity: quantidade, maxPrice: teto, expect: acao < 0.5 ? "new" : "existing" });
    if (r.status < 300) this.resumo.ofertasNoIpo++;
  }

  private async negociar(jogador: Jogador): Promise<void> {
    const ticker = this.escolher(this.carga.tickers);
    const livro = await jogador.livro(ticker);
    if (!livro.me || livro.market?.state !== "open") return;
    const compra = this.sorteio() < 0.5 || livro.me.freeShares === 0;
    const base = livro.price.displayed;
    const preco = Math.min(livro.me.band.max, Math.max(livro.me.band.min, Math.round(base * (1 + (this.sorteio() - 0.5) * 0.04))));
    const quantidade = compra
      ? Math.max(1, Math.floor(Math.min(livro.me.freeCash / preco, 5 + this.sorteio() * 30)))
      : Math.max(1, Math.min(livro.me.freeShares, 1 + Math.floor(this.sorteio() * 20)));
    const r = await jogador.http("POST", "/orders", { ticker, side: compra ? "buy" : "sell", type: "limit", quantity: quantidade, limitPrice: preco });
    if (r.status < 300) this.resumo.ordens++;
    if (this.sorteio() < 0.2) {
      const abertas = await jogador.http<{ orders?: Array<{ id: number }> }>("GET", "/orders?status=open");
      const ordem = abertas.corpo?.orders?.[0];
      if (ordem && (await jogador.http("DELETE", `/orders/${ordem.id}`)).status < 300) this.resumo.cancelamentos++;
    }
    await jogador.http("GET", "/portfolio");
    await jogador.http("GET", "/rankings/live");
  }

  /**
   * Livro 18, 19, 35: o livro montado só com os eventos do WebSocket é igual ao da rota REST. A publicação do `book` junta
   * eventos (4 por segundo no máximo), então a conferência espera o último chegar, até 3 segundos de relógio de verdade.
   */
  async conferirLivrosDoOuvinte(): Promise<void> {
    const ouvinte = this.observador;
    const ws = ouvinte.ws!;
    for (const ticker of this.carga.tickers) {
      const estado = ws.canais.get(`club:${ticker}`);
      if (!estado?.ultimoLivro) continue; // clube sem movimento ainda
      const limite = Date.now() + 15_000;
      for (;;) {
        const resposta = await ouvinte.http<BookView & { code?: string }>("GET", `/clubs/${ticker}/book`);
        // limite de taxa (429) ou outro erro passageiro: espera e tenta de novo; se persistir, a mensagem mostra o que a rota disse
        if (resposta.status !== 200 || !resposta.corpo?.bids) {
          if (Date.now() > limite) throw new Error(`a rota do livro de ${ticker} respondeu ${resposta.status}: ${JSON.stringify(resposta.corpo).slice(0, 200)}`);
          await new Promise((r) => setTimeout(r, 1100));
          continue;
        }
        const rest = resposta.corpo;
        const ev = ws.canais.get(`club:${ticker}`)!.ultimoLivro!;
        const niveis = (l: Array<{ price: number; quantity: number }>) => JSON.stringify(l.map((n) => [n.price, n.quantity]));
        if (niveis(rest.bids) === niveis(ev.bids) && niveis(rest.asks) === niveis(ev.asks)) break;
        if (Date.now() > limite) throw new Error(`o livro de ${ticker} montado pelo WebSocket difere do da REST: REST ${niveis(rest.bids)} × WS ${niveis(ev.bids)}`);
        await new Promise((r) => setTimeout(r, 250));
      }
      this.resumo.conferenciasDeLivro++;
      if (ws.canais.get(`club:${ticker}`)!.buracos > 0) throw new Error(`o canal club:${ticker} perdeu eventos (buraco no seq)`);
    }
  }

  fechar(): void {
    for (const j of [...this.lista, this.observador]) j?.ws?.fechar();
  }
}
