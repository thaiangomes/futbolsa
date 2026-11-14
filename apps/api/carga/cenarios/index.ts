import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { BOT_PROFILE_NAMES } from "@futbolsa/contracts";
import { Histograma } from "../medidores.js";
import { abrirConexoes, medir, perfilDe, verificarInvariantes, type Preparado } from "../gerador.js";
import { AVISO_DE_AMBIENTE, type ResultadoDoCenario } from "../relatorio.js";
import type { ResumoHistograma } from "../medidores.js";
import type { Escala } from "./escalas.js";

/**
 * Os cenários de carga (T17). Cada um recebe a carga já preparada (mundo e jogadores) e devolve o relatório. Os identificadores
 * `a` a `g` são os do plano; (g), o encerramento com 10 mil carteiras, ainda não tem cenário (veja o aviso no relatório dele).
 */

export type Log = (linha: string) => void;
export type Cenario = (p: Preparado, e: Escala, log: Log) => Promise<ResultadoDoCenario>;

/** (a) o pico da meta: 100 ordens por segundo, metade num clube, com as conexões abertas, depois de uma rampa de 10 s + 10 s. */
const pico: Cenario = (p, e, log) =>
  medir(
    p,
    {
      nome: "a-pico",
      descricao: `O pico da meta: ${e.ordensPorSegundo} ordens/s sustentadas (rampa de 25% e 50% antes), metade no clube quente, com ${e.conexoes} conexões WebSocket assinando prices, club e me.`,
      degraus: [
        { ordensPorSegundo: Math.max(1, Math.round(e.ordensPorSegundo / 4)), segundos: 10 },
        { ordensPorSegundo: Math.max(1, Math.round(e.ordensPorSegundo / 2)), segundos: 10 },
        { ordensPorSegundo: e.ordensPorSegundo, segundos: e.segundosDoPico },
      ],
      conexoes: e.conexoes,
    },
    log,
  );

/** (b) degraus no clube quente, para achar o limite por clube: o último degrau que mantém o ritmo, a latência e a trava dentro da meta. */
const degraus: Cenario = async (p, e, log) => {
  const porDegrau: Array<Record<string, unknown>> = [];
  let ultimo: ResultadoDoCenario | undefined;
  let limite = 0;
  for (const [i, ritmo] of e.degraus.entries()) {
    const r = await medir(
      p,
      {
        nome: "b-degraus",
        descricao: "",
        degraus: [{ ordensPorSegundo: ritmo, segundos: e.segundosPorDegrau }],
        perfil: { soQuente: true, leiturasPorOrdem: 0 },
        verificar: i === e.degraus.length - 1,
        pausaMs: 3000,
      },
      log,
    );
    ultimo = r;
    const d = r.degraus[0]!;
    const quente = r.servidor?.clubes[p.mundo.tickers[0]!];
    const dentro = d.enviadoPorSegundo >= ritmo * 0.95 && (d.latencia.ordem_limite?.p95 ?? 0) <= 250 && (d.status["5xx"] ?? 0) === 0 && (quente?.retencao.p95 ?? 0) <= 10;
    if (dentro) limite = ritmo;
    porDegrau.push({
      ritmo,
      enviado: d.enviadoPorSegundo,
      postP50: d.latencia.ordem_limite?.p50,
      postP95: d.latencia.ordem_limite?.p95,
      postP99: d.latencia.ordem_limite?.p99,
      emVoo: d.emVoo,
      status: d.status,
      esperaDoClubeP95: quente?.espera.p95,
      retencaoDoClubeP50: quente?.retencao.p50,
      retencaoDoClubeP95: quente?.retencao.p95,
      retencaoDoClubeP99: quente?.retencao.p99,
      dentroDaMeta: dentro,
    });
  }
  const resultado: ResultadoDoCenario = {
    ...ultimo!,
    cenario: "b-degraus",
    descricao: `Degraus de ${e.degraus.join(", ")} ordens/s só no clube quente (${p.mundo.tickers[0]}), ${e.segundosPorDegrau} s cada, para achar o limite por clube.`,
    degraus: [],
    extras: { limitePorClubeOrdensPorSegundo: limite, porDegrau, criterioDoLimite: "enviado ≥ 95% do pedido, POST p95 ≤ 250 ms, nenhum 5xx e retenção da trava do clube p95 ≤ 10 ms" },
  };
  resultado.metas = [{ meta: `limite por clube medido (ordens/s dentro da meta)`, valor: String(limite), ok: limite >= 100 / 2 }, ...ultimo!.metas.filter((m) => m.meta.startsWith("invariantes"))];
  return resultado;
};

/** (c) todos os clubes negociando com a casa: metade das ordens a mercado, que casam com a oferta da casa, para medir a espera na tesouraria. */
const tesouraria: Cenario = async (p, e, log) => {
  await p.controle.cenario("reposicao");
  return medir(
    p,
    {
      nome: "c-tesouraria",
      descricao: `Todos os clubes negociando com a casa: ${e.ordensPorSegundo} ordens/s espalhadas pelos ${p.mundo.tickers.length} clubes, 60% a mercado (casam com as ofertas da casa), para medir a espera na tesouraria.`,
      degraus: [{ ordensPorSegundo: e.ordensPorSegundo, segundos: Math.min(e.segundosDoPico, 60) }],
      perfil: { fracaoQuente: 0, fracaoMercado: 0.6, fracaoCancelamento: 0.05, leiturasPorOrdem: 0 },
    },
    log,
  );
};

/** (d) reconexão em massa: derruba a API com as conexões abertas, sobe de novo e mede em quanto tempo todas voltam. */
const reconexao: Cenario = async (p, e, log) => {
  const inicio = new Date().toISOString();
  const perfil = perfilDe(p);
  const pool = await abrirConexoes(p, e.conexoesDaQueda, perfil.clubeQuente);
  const antes = pool.abertas;
  log(`${antes} conexões prontas; derrubando a API...`);
  const derrubadaEm = performance.now();
  await fetch(`${p.controle.url}/derrubar`, { method: "POST", body: "{}" });
  await new Promise((ok) => setTimeout(ok, 2000));
  await fetch(`${p.controle.url}/subir`, { method: "POST", body: "{}" });
  const sobiuEm = performance.now();
  // as leituras REST logo depois da volta não podem dar 5xx
  const leituras = await Promise.all(Array.from({ length: 20 }, () => fetch(`${p.apiUrl}/clubs`).then((r) => r.status).catch(() => 0)));
  const prontas = await pool.esperarProntas(antes, 90_000);
  const voltaramEm = performance.now();
  const estat = pool.estatisticas();
  const retomada: ResumoHistograma = pool.retomadas.resumo();
  pool.fecharTodas();
  const todasVoltaram = prontas >= antes;
  const segundos = Math.round(((voltaramEm - sobiuEm) / 1000) * 10) / 10;
  return {
    cenario: "d-reconexao",
    descricao: `Reconexão em massa: ${antes} conexões abertas, a API cai por 2 s e volta; mede o tempo até todas assinarem de novo (meta: 60 s).`,
    inicio,
    configuracao: { conexoes: antes },
    degraus: [],
    conexoes: estat,
    invariantes: "nao_rodou",
    extras: { derrubadaPorMs: Math.round(sobiuEm - derrubadaEm), todasVoltaram, segundosDaSubidaAteTodasVoltarem: segundos, retomadaPorConexaoMs: retomada, leiturasRestDepoisDaVolta: leituras },
    metas: [
      { meta: "todas as conexões retomam em até 60 s depois da queda", valor: `${prontas}/${antes} em ${segundos} s`, ok: todasVoltaram && segundos <= 60 },
      { meta: "nenhum erro 5xx na REST depois da volta", valor: leituras.filter((s) => s >= 500 || s === 0).length + " erros", ok: leituras.every((s) => s < 500 && s !== 0) },
    ],
    aviso: AVISO_DE_AMBIENTE,
  };
};

/** (e) leituras quentes com histórico grande: carrega o histórico, mede as rotas de leitura e os planos das consultas, e o patrimônio diário e a foto mensal de todas as carteiras. */
const leituras: Cenario = async (p, e, log) => {
  const inicio = new Date().toISOString();
  const clubId = p.mundo.clubIds.get(p.mundo.tickers[0]!)!;
  const ticker = p.mundo.tickers[0]!;
  const [comprador, vendedor] = [p.jogadores[0]!, p.jogadores[1]!];
  const faixa = Math.min(100, p.jogadores.length);
  const carteiras = p.jogadores.slice(0, faixa).map((j) => j.walletId);
  const modelo = readFileSync(new URL("../historico.sql", import.meta.url), "utf8");
  const valores: Record<string, number> = {
    season: p.mundo.seasonId,
    club: clubId,
    buyer: comprador.walletId,
    seller: vendedor.walletId,
    n: e.negociosDeHistorico,
    entries: e.linhasDeExtrato,
    wallet_from: Math.min(...carteiras),
    wallet_to: Math.max(...carteiras),
  };
  const textoSql = modelo.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(valores[k]));
  log(`carregando o histórico: ${e.negociosDeHistorico} negócios, ${e.linhasDeExtrato} linhas de extrato...`);
  const t0 = performance.now();
  await p.db.pool.query(textoSql);
  p.historicoCarregado = true;
  const carregouEm = Math.round(performance.now() - t0);
  await p.db.pool.query("analyze");
  log(`  histórico carregado em ${(carregouEm / 1000).toFixed(1)} s`);

  // os tokens se revezam entre os jogadores que têm histórico (o limite de uso é por pessoa: 300 por minuto)
  const revezamento = p.jogadores.slice(0, Math.min(30, faixa)).map((j) => j.token);
  let giro = 0;
  const proximoToken = () => revezamento[giro++ % revezamento.length]!;
  const rotas: Array<{ nome: string; caminho: string }> = [
    { nome: "livro", caminho: `/clubs/${ticker}/book` },
    { nome: "candles_temporada", caminho: `/clubs/${ticker}/candles?range=season` },
    { nome: "candles_30d", caminho: `/clubs/${ticker}/candles?range=30d` },
    { nome: "carteira", caminho: "/portfolio" },
    { nome: "extrato", caminho: "/portfolio/entries" },
    { nome: "patrimonio", caminho: "/portfolio/equity" },
  ];
  const latencias: Record<string, ResumoHistograma & { status: Record<string, number> }> = {};
  const sozinhas: Record<string, ResumoHistograma> = {};
  for (const rota of rotas) {
    const h = new Histograma();
    const status: Record<string, number> = {};
    // primeiro, uma por vez (a latência da rota sozinha); depois, dez ao mesmo tempo (a rota sob concorrência)
    const sozinha = new Histograma();
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      const res = await fetch(`${p.apiUrl}${rota.caminho}`, { headers: { authorization: `Bearer ${proximoToken()}` } });
      await res.text();
      sozinha.registrar(performance.now() - t);
    }
    sozinhas[rota.nome] = sozinha.resumo();
    const requisicoes = 150;
    for (let inicioDoLote = 0; inicioDoLote < requisicoes; inicioDoLote += 10) {
      await Promise.all(
        Array.from({ length: 10 }, async () => {
          const t = performance.now();
          const res = await fetch(`${p.apiUrl}${rota.caminho}`, { headers: { authorization: `Bearer ${proximoToken()}` } });
          await res.text();
          h.registrar(performance.now() - t);
          status[String(res.status)] = (status[String(res.status)] ?? 0) + 1;
        }),
      );
    }
    latencias[rota.nome] = { ...h.resumo(), status };
    log(`  ${rota.nome}: sozinha p50 ${sozinhas[rota.nome]!.p50} ms; 10 juntas p50 ${latencias[rota.nome]!.p50} ms, p95 ${latencias[rota.nome]!.p95} ms (${JSON.stringify(status)})`);
  }

  // os planos das consultas das rotas, com o histórico carregado
  const explicar = async (nome: string, consulta: string): Promise<{ nome: string; ms: number | null; plano: string[] }> => {
    const r = await p.db.pool.query(`explain (analyze, buffers) ${consulta}`);
    const linhas = r.rows.map((l: Record<string, string>) => l["QUERY PLAN"]!);
    const exec = linhas.find((l) => l.startsWith("Execution Time"));
    return { nome, ms: exec ? Number(/([\d.]+) ms/.exec(exec)![1]) : null, plano: linhas.slice(0, 12) };
  };
  const planos = [
    await explicar("livro: 5 melhores compras abertas", `select id, limit_price, quantity - filled from futbolsa.orders where club_id = ${clubId} and status = 'open' and side = 'buy' order by limit_price desc, id limit 5`),
    await explicar("extrato: 50 últimas linhas da carteira", `select * from futbolsa.wallet_entries where wallet_id = ${comprador.walletId} order by at desc, id desc limit 50`),
    await explicar("candles de 15 minutos do clube na temporada", `select * from futbolsa.candles where club_id = ${clubId} and "interval" = '15m' order by start`),
    await explicar("últimos 50 negócios do clube", `select * from futbolsa.trades where club_id = ${clubId} order by at desc, id desc limit 50`),
    await explicar("negócios da carteira no clube (marcadores)", `select * from futbolsa.trades where club_id = ${clubId} and (buyer_wallet_id = ${comprador.walletId} or seller_wallet_id = ${comprador.walletId}) order by at`),
  ];

  const equity = await p.controle.cenario<{ ms: number }>("equity-diario");
  const foto = await p.controle.cenario<{ ms: number; gravadas: number }>("foto-mensal", { seasonId: p.mundo.seasonId });
  const piorP95 = Math.max(...Object.values(latencias).map((l) => l.p95));
  return {
    cenario: "e-leituras",
    descricao: `Leituras quentes com histórico grande (${e.negociosDeHistorico} negócios, ${e.linhasDeExtrato} linhas de extrato) e as tarefas de patrimônio com ${p.jogadores.length} carteiras.`,
    inicio,
    configuracao: { negocios: e.negociosDeHistorico, extrato: e.linhasDeExtrato, carteiras: p.jogadores.length },
    degraus: [],
    invariantes: "nao_rodou",
    extras: {
      carregarHistoricoMs: carregouEm,
      latenciaPorRota: latencias,
      latenciaDeUmaPorVez: sozinhas,
      planos,
      patrimonioDiarioMs: Math.round(equity.ms),
      fotoMensalMs: Math.round(foto.ms),
      fotoMensalGravadas: foto.gravadas,
      nota: "Depois do histórico, os candles deixam de ser os dos negócios: o verificador de invariantes não vale neste cenário (veja historico.sql).",
    },
    metas: [
      { meta: "leituras quentes com p95 ≤ 250 ms (a mesma meta do POST)", valor: `pior p95 ${piorP95} ms`, ok: piorP95 <= 250 },
      { meta: "nenhuma resposta fora de 2xx nas leituras", valor: JSON.stringify(Object.fromEntries(Object.entries(latencias).map(([k, v]) => [k, v.status]))), ok: Object.values(latencias).every((l) => Object.keys(l.status).every((s) => s === "200")) },
    ],
    aviso: AVISO_DE_AMBIENTE,
  };
};

/** (f) a tarefa dos bots com `botsPorPerfil` bots de cada perfil: duração de uma rodada e o que ela fez. */
const bots: Cenario = async (p, e, log) => {
  const inicio = new Date().toISOString();
  const counts = Object.fromEntries(BOT_PROFILE_NAMES.map((n) => [n, e.botsPorPerfil]));
  const total = e.botsPorPerfil * BOT_PROFILE_NAMES.length;
  const ligacao = await p.controle.cenario<{ status: number; corpo?: string }>("ligar-bots", { counts });
  log(`bots ligados (${total}): ${ligacao.status}`);
  const rodadas: Array<{ ms: number; relatorio: unknown }> = [];
  for (let i = 0; i < 4; i++) {
    rodadas.push(await p.controle.cenario<{ ms: number; relatorio: unknown }>("rodada-bots", { tickMinutes: 180 }));
    log(`  rodada ${i + 1}: ${Math.round(rodadas[i]!.ms)} ms`);
  }
  const duracoes = rodadas.map((r) => r.ms);
  const invariantes = await verificarInvariantes(p);
  const pior = Math.max(...duracoes);
  return {
    cenario: "f-bots",
    descricao: `A tarefa dos bots com ${e.botsPorPerfil} bots de cada um dos ${BOT_PROFILE_NAMES.length} perfis (${total} no total; o limite proposto da F14 é 200 por perfil, 1.800): quatro rodadas seguidas.`,
    inicio,
    configuracao: { botsPorPerfil: e.botsPorPerfil, total },
    degraus: [],
    invariantes,
    extras: { ligacao, duracoesMs: duracoes.map(Math.round), rodadas },
    metas: [
      { meta: "bots ligados pelo admin (200 por perfil no CI)", valor: String(ligacao.status), ok: ligacao.status < 300 },
      { meta: "uma rodada dura menos que o intervalo dela (15 min)", valor: `${Math.round(pior)} ms no pior caso`, ok: pior < 15 * 60_000 },
      { meta: "invariantes passam no fim", valor: invariantes.ok ? "passaram" : "violadas", ok: invariantes.ok },
    ],
    aviso: AVISO_DE_AMBIENTE,
  };
};

/** (g) o encerramento com 10 mil carteiras: não implementado nesta etapa (veja `extras.nota`). */
const encerramento: Cenario = async (_p, e) => ({
  cenario: "g-encerramento",
  descricao: "O encerramento com 10 mil carteiras (T10 da F15) com o relógio de verdade.",
  inicio: new Date().toISOString(),
  configuracao: { escala: e.nome },
  degraus: [],
  invariantes: "nao_rodou",
  extras: {
    nota: "Pendente: o fechamento da temporada (SeasonCloseService) pede recompra fechada, pagamentos liquidados e a Série B; montar esse estado em lote pede uma fixture própria. A parte que escala com o número de carteiras, a foto mensal, é medida no cenário (e). O ensaio completo da T14 cobre o encerramento com o fluxo de verdade em escala menor.",
  },
  metas: [],
  aviso: AVISO_DE_AMBIENTE,
});

export const CENARIOS: Record<string, Cenario> = { pico, degraus, tesouraria, reconexao, leituras, bots, encerramento };
/** A ordem de "todos": o que estraga o estado (histórico sem candles coerentes, bots) fica por último. */
export const ORDEM_DE_TODOS = ["pico", "degraus", "tesouraria", "reconexao", "bots", "leituras", "encerramento"] as const;
