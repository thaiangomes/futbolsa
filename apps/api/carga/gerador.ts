import { performance } from "node:perf_hooks";
import { connect, type DbConnection } from "../src/infra/db/client.js";
import { verificarDia } from "../ensaio/invariantes.js";
import { PoolDeConexoes, type AlvoDeConexao } from "./conexoes.js";
import type { RelatorioMedidas } from "./medidores.js";
import { criarJogadores, prepararMundo, type Jogador, type Mundo, type OpcoesPopulacao } from "./populacao.js";
import { AVISO_DE_AMBIENTE, type ResultadoDoCenario } from "./relatorio.js";
import { PERFIL_PADRAO, Trafego, type Degrau, type PerfilDeTrafego, type ResultadoDoDegrau } from "./trafego.js";

/**
 * O gerador de carga (T16): um processo separado da API. Fala com ela só por HTTP e WebSocket, com a porta de controle do
 * servidor da carga (`carga/servidor.ts`) para pegar tokens e as medidas, e com o banco direto para criar a população em
 * lote e rodar o verificador de invariantes no fim.
 */

export class ControleDaCarga {
  constructor(readonly url: string) {}

  async cenario<T = Record<string, unknown>>(nome: string, corpo: object = {}): Promise<T> {
    const res = await fetch(`${this.url}/cenario/${nome}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(corpo) });
    const texto = await res.text();
    if (!res.ok) throw new Error(`controle ${nome} → ${res.status}: ${texto.slice(0, 300)}`);
    return JSON.parse(texto) as T;
  }

  async medidas(): Promise<RelatorioMedidas> {
    return (await this.cenario<{ medidas: RelatorioMedidas }>("medidas")).medidas;
  }
}

export interface OpcoesDoGerador {
  controleUrl: string;
  /** O banco da API (o mesmo do servidor da carga): a população entra direto nele. */
  databaseUrl: string;
  populacao: OpcoesPopulacao;
  log?: (linha: string) => void;
}

export interface Preparado {
  controle: ControleDaCarga;
  db: DbConnection;
  mundo: Mundo;
  jogadores: Array<Jogador & { token: string }>;
  apiUrl: string;
  deslocamentoMs: number;
  fechar(): Promise<void>;
}

export async function prepararCarga(o: OpcoesDoGerador): Promise<Preparado> {
  const log = o.log ?? (() => undefined);
  const controle = new ControleDaCarga(o.controleUrl);
  const db = connect(o.databaseUrl, 10);
  const t0 = performance.now();
  const mundo = await prepararMundo(db.db, o.populacao);
  log(`mundo pronto: ${mundo.tickers.length} clubes (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  const jogadores = await criarJogadores(db.db, mundo, o.populacao, (n) => {
    if (n % 5000 === 0) log(`  ${n} jogadores criados`);
  });
  log(`${jogadores.length} jogadores com carteira (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  const tokens: Record<string, string> = {};
  for (let i = 0; i < jogadores.length; i += 1000) {
    const parte = jogadores.slice(i, i + 1000).map((j) => j.subject);
    Object.assign(tokens, (await controle.cenario<{ tokens: Record<string, string> }>("tokens", { subjects: parte })).tokens);
  }
  const hora = await controle.cenario<{ deslocamentoMs: number; apiUrl: string }>("hora");
  return {
    controle,
    db,
    mundo,
    jogadores: jogadores.map((j) => ({ ...j, token: tokens[j.subject]! })),
    apiUrl: hora.apiUrl,
    deslocamentoMs: hora.deslocamentoMs,
    fechar: () => db.close(),
  };
}

/** Abre `n` conexões WebSocket, espalhadas entre os jogadores, cada uma com os canais `prices`, `club:<quente>` e `me`. */
export async function abrirConexoes(p: Preparado, n: number, clubeQuente: string, prazoMs = 120_000): Promise<PoolDeConexoes> {
  const pool = new PoolDeConexoes({ wsUrl: `${p.apiUrl.replace("http", "ws")}/ws`, origem: process.env.WEB_ORIGIN ?? "http://localhost:3001", deslocamentoMs: p.deslocamentoMs });
  const porPessoa = Math.ceil(n / p.jogadores.length);
  if (porPessoa > 5) throw new Error(`${n} conexões pedem pelo menos ${Math.ceil(n / 5)} jogadores (o servidor aceita 5 por pessoa)`);
  const alvos: AlvoDeConexao[] = Array.from({ length: n }, (_, i) => ({ token: p.jogadores[i % p.jogadores.length]!.token, canais: ["prices", `club:${clubeQuente}`, "me"] }));
  await pool.abrir(alvos);
  await pool.esperarProntas(n, prazoMs);
  return pool;
}

export function perfilDe(p: Preparado, mudancas: Partial<PerfilDeTrafego> = {}): PerfilDeTrafego {
  return { ...PERFIL_PADRAO, tickers: p.mundo.tickers, clubeQuente: p.mundo.tickers[0]!, ...mudancas };
}

export interface OpcoesMedicao {
  nome: string;
  descricao: string;
  degraus: Degrau[];
  perfil?: Partial<PerfilDeTrafego>;
  conexoes?: number;
  /** Jogadores que mandam ordens: os primeiros `n` (padrão todos). */
  jogadoresAtivos?: number;
  verificar?: boolean;
  /** Pausa entre os degraus, para o servidor esvaziar a fila. */
  pausaMs?: number;
}

/** O cenário padrão: reinicia as medidas, abre as conexões, roda os degraus, lê as medidas e confere as invariantes. */
export async function medir(p: Preparado, o: OpcoesMedicao, log: (l: string) => void = () => undefined): Promise<ResultadoDoCenario> {
  const inicio = new Date().toISOString();
  const perfil = perfilDe(p, o.perfil);
  let pool: PoolDeConexoes | undefined;
  if (o.conexoes) {
    log(`abrindo ${o.conexoes} conexões WebSocket...`);
    pool = await abrirConexoes(p, o.conexoes, perfil.clubeQuente);
    log(`  ${pool.abertas} prontas`);
  }
  await p.controle.cenario("reiniciar-medidas");
  pool?.zerarMedidas();
  const ativos = p.jogadores.slice(0, o.jogadoresAtivos ?? p.jogadores.length);
  const trafego = new Trafego(p.apiUrl, ativos, perfil);
  const degraus: ResultadoDoDegrau[] = [];
  for (const d of o.degraus) {
    log(`degrau de ${d.ordensPorSegundo} ordens/s por ${d.segundos} s`);
    const r = await trafego.rodar(d);
    degraus.push(r);
    log(`  enviado ${r.enviadoPorSegundo}/s, 2xx ${r.status["2xx"] ?? 0}, 5xx ${r.status["5xx"] ?? 0}, POST p95 ${(r.latencia.ordem_limite?.p95 ?? 0).toFixed(0)} ms, em voo ${r.emVoo}`);
    if (o.pausaMs) await new Promise((ok) => setTimeout(ok, o.pausaMs));
  }
  // um instante para os últimos eventos chegarem às conexões
  if (pool) await new Promise((ok) => setTimeout(ok, 2000));
  const servidor = await p.controle.medidas();
  const memoria = await p.controle.cenario<{ rssMb: number }>("memoria");
  const resultado: ResultadoDoCenario = {
    cenario: o.nome,
    descricao: o.descricao,
    inicio,
    configuracao: { jogadores: p.jogadores.length, clubes: p.mundo.tickers.length, conexoes: o.conexoes ?? 0, clubeQuente: perfil.clubeQuente, perfil, degraus: o.degraus },
    degraus,
    conexoes: pool?.estatisticas(),
    servidor,
    memoria: { servidorRssMb: memoria.rssMb, geradorRssMb: Math.round(process.memoryUsage().rss / 1048576) },
    invariantes: "nao_rodou",
    metas: [],
    aviso: AVISO_DE_AMBIENTE,
  };
  pool?.fecharTodas();
  if (o.verificar !== false) resultado.invariantes = await verificarInvariantes(p);
  resultado.metas = avaliarMetas(resultado, perfil.clubeQuente);
  return resultado;
}

/** O verificador da T8 sobre o banco depois do cenário (sem o detector de relógio: o relógio da carga é o de verdade). */
export async function verificarInvariantes(p: Preparado): Promise<{ ok: boolean; violacoes: string[] }> {
  try {
    const hora = await p.controle.cenario<{ agora: string }>("hora");
    await verificarDia(p.db.db, p.mundo.seasonId, { em: new Date(hora.agora) }, undefined, { relogio: false });
    return { ok: true, violacoes: [] };
  } catch (erro) {
    return { ok: false, violacoes: (erro as Error).message.split("\n").slice(0, 20) };
  }
}

/** As metas da seção "Carga" do plano; quem lê o relatório vê o que passou e o que ficou fora. */
export function avaliarMetas(r: ResultadoDoCenario, clubeQuente: string): ResultadoDoCenario["metas"] {
  const metas: ResultadoDoCenario["metas"] = [];
  const s = r.servidor;
  const ordens = r.degraus.reduce((n, d) => n + d.ordens, 0);
  const cincoXX = r.degraus.reduce((n, d) => n + (d.status["5xx"] ?? 0) + (d.status.rede ?? 0), 0);
  const pior = (f: (d: ResultadoDoDegrau) => number) => Math.max(0, ...r.degraus.map(f));
  const pedido = Math.max(0, ...r.degraus.map((d) => d.pedidoPorSegundo));
  const enviado = Math.min(...r.degraus.map((d) => d.enviadoPorSegundo / d.pedidoPorSegundo));
  metas.push({ meta: "nenhum erro 5xx", valor: String(cincoXX), ok: cincoXX === 0 });
  metas.push({ meta: `ritmo sustentado (≥ 95% do pedido, até ${pedido}/s)`, valor: `${Math.round(enviado * 100)}%`, ok: enviado >= 0.95 });
  const post95 = pior((d) => d.latencia.ordem_limite?.p95 ?? 0);
  metas.push({ meta: "POST /orders p95 ≤ 250 ms", valor: `${post95.toFixed(0)} ms`, ok: post95 <= 250 });
  const clube = s?.clubes[clubeQuente];
  if (clube) {
    metas.push({ meta: `retenção da trava do clube quente p95 ≤ 10 ms`, valor: `${clube.retencao.p95} ms`, ok: clube.retencao.p95 <= 10 });
    metas.push({ meta: `retenção da trava do clube quente p99 ≤ 25 ms`, valor: `${clube.retencao.p99} ms`, ok: clube.retencao.p99 <= 25 });
    metas.push({ meta: `espera pela trava do clube quente p95 ≤ 50 ms`, valor: `${clube.espera.p95} ms`, ok: clube.espera.p95 <= 50 });
  }
  const tes = s?.travas.wallet_treasury;
  if (tes) metas.push({ meta: "espera na tesouraria p95 ≤ 20 ms", valor: `${tes.espera.p95} ms (n=${tes.espera.n})`, ok: tes.espera.p95 <= 20 });
  if (s) {
    const taxa = ordens === 0 ? 0 : s.repeticoes.total / ordens;
    metas.push({ meta: "repetição por deadlock < 0,1% e nenhuma esgotada", valor: `${(taxa * 100).toFixed(3)}%, esgotadas ${s.repeticoes.esgotadas}`, ok: taxa < 0.001 && s.repeticoes.esgotadas === 0 });
  }
  const atr = r.conexoes?.atraso;
  if (atr?.trade) metas.push({ meta: "trade entregue p95 ≤ 1 s (cliente)", valor: `${atr.trade.p95} ms`, ok: atr.trade.p95 <= 1000 });
  if (atr?.book) metas.push({ meta: "book entregue p95 ≤ 750 ms (cliente)", valor: `${atr.book.p95} ms`, ok: atr.book.p95 <= 750 });
  metas.push({ meta: "invariantes passam no fim", valor: r.invariantes === "nao_rodou" ? "não rodou" : r.invariantes.ok ? "passaram" : "violadas", ok: r.invariantes !== "nao_rodou" && r.invariantes.ok });
  return metas;
}
