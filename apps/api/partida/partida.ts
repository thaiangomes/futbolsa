import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { eq, or, sql } from "drizzle-orm";
import { ipoDates, type Match } from "@futbolsa/engine";
import { authIdentities, clubs, seasons, users } from "../src/infra/db/schema/index.js";
import { connect } from "../src/infra/db/client.js";
import { tokenFor } from "../test/support/auth.js";
import { contagemDeBots, ligarBots } from "../ensaio/bots.js";
import { type Carregado, carregarTemporada } from "../ensaio/carregar.js";
import { Condutor } from "../ensaio/condutor.js";
import { ReplaySource } from "../ensaio/replay-source.js";
import { criarServidorEnsaio, type ServidorEnsaio } from "../ensaio/servidor.js";
import { manipuladorDoSite } from "../ensaio/navegador.js";
import { criarConta, type ContaEnsaio } from "../ensaio/contas.js";
import { prepararBanco, criarTabelasDaPartida } from "./banco.js";
import { ANO_DA_PARTIDA, arquivoDaSerieA, atualizarFotos, fotosMaisNovas, paraMemoria, semearFotos, type Baixador } from "./dados.js";
import { AgenteDaPartida } from "./bots.js";
import { recusarAmbienteDaPartida } from "./guardas.js";
import { PORTAS_DA_PARTIDA } from "./portas.js";
import { ModuloDaPartida, PorRelogio } from "./modulo.js";
import { type Pedido, RelogioDaPartida, RelogioFlutuante } from "./relogio.js";

/**
 * A partida de teste (F17, T5): a API inteira com o relógio da partida, a fonte de reprodução de 2026 (dados no banco), os 9
 * perfis de bot, a conta de jogador e a de admin (separadas), o site estático e uma porta de controle para o terminal, tudo num
 * processo só, só em 127.0.0.1. Mora em `apps/api/partida/`, fora de `src/` e da imagem Docker: nada daqui vai à produção.
 */

const DIA = 86_400_000;
/** Os tokens do login falso valem muito mais que a vida do jogo: o relógio da partida pula meses. */
const VALIDADE_DO_TOKEN_S = 400 * 86_400;

export interface OpcoesDaPartida {
  /** Postgres local (o banco `futbolsa_partida` é criado ao lado). */
  urlBanco: string;
  /** O site estático (export do Next feito para a partida). */
  pastaDoSite: string;
  /** Escala dos bots (0,2 = 50 bots dos 9 perfis). Só vale na primeira subida; depois, a tela de bots do admin. */
  escala?: number;
  portaApi?: number;
  portaSite?: number;
  portaControle?: number;
  apelido?: string;
  adminApelido?: string;
  /** O admin de teste aprova os pagamentos sozinho (padrão: não, a aprovação é um passo do admin). */
  aprovarSozinho?: boolean;
  /** Liga o laço do tempo real (os testes ligam à mão). */
  laco?: boolean;
  /** Relógio de verdade (os testes trocam por um que anda quando eles querem). */
  agoraReal?: () => number;
  baixar?: Baixador;
  /** Sem site nem porta de controle (os testes). */
  semPortas?: boolean;
  host?: string;
  /** Outro nome de banco (os testes; sempre `futbolsa_partida_<sufixo>`). */
  nomeDoBanco?: string;
}

export interface Partida {
  servidor: ServidorEnsaio;
  relogio: RelogioDaPartida;
  clock: RelogioFlutuante;
  carga: Carregado;
  condutor: Condutor;
  bots: AgenteDaPartida;
  jogador: ContaEnsaio;
  siteUrl: string;
  controleUrl: string;
  /** Primeira subida desta partida (o banco acabou de ser criado). */
  nova: boolean;
  fechar(): Promise<void>;
}

/**
 * Acha a conta pelo apelido atual ou pelo e-mail com que a partida a criou (`<apelido>@exemplo.com`): o jogador pode mudar o
 * apelido na tela da conta, e a retomada não pode depender de ele ser o do começo.
 */
async function contaPorApelido(db: ServidorEnsaio["conexao"]["db"], apelido: string, clock: RelogioFlutuante): Promise<ContaEnsaio | null> {
  const [l] = await db
    .select({ id: users.id, email: users.email, nickname: users.nickname, subject: authIdentities.subject })
    .from(users)
    .innerJoin(authIdentities, eq(authIdentities.userId, users.id))
    .where(or(eq(users.nickname, apelido), eq(users.email, `${apelido}@exemplo.com`)));
  if (!l?.email || !l.nickname) return null;
  const tokenWith = (opcoes: { at?: Date; expiresIn?: number } = {}) => tokenFor({ ...opcoes, subject: l.subject, email: l.email! });
  return {
    conta: { id: l.id, subject: l.subject, email: l.email, nickname: l.nickname, token: "", tokenWith },
    auth: async () => ({ authorization: `Bearer ${await tokenWith({ at: clock.now(), expiresIn: VALIDADE_DO_TOKEN_S })}` }),
  };
}

export async function subirPartida(o: OpcoesDaPartida): Promise<Partida> {
  const host = o.host ?? "127.0.0.1";
  recusarAmbienteDaPartida({ urlBanco: o.urlBanco, host });
  const portaApi = o.portaApi ?? PORTAS_DA_PARTIDA.api;
  const portaSite = o.portaSite ?? PORTAS_DA_PARTIDA.site;
  const portaControle = o.portaControle ?? PORTAS_DA_PARTIDA.controle;
  const apelido = o.apelido ?? "jogador";
  const adminApelido = o.adminApelido ?? "admin_partida";
  // o WebSocket e o CORS só aceitam o site da partida
  process.env.WEB_ORIGIN = `http://127.0.0.1:${portaSite}`;

  const banco = await prepararBanco(o.urlBanco, o.nomeDoBanco);
  const prep = connect(banco.url, 2);
  let fotos;
  let salvo: { instante: Date } | undefined;
  try {
    await criarTabelasDaPartida(prep.db);
    await semearFotos(prep.db);
    fotos = await fotosMaisNovas(prep.db);
    const r = await prep.db.execute<{ instante: Date }>(sql`select instante from public.partida_estado where id = 1`);
    salvo = r.rows[0] ? { instante: new Date(r.rows[0].instante) } : undefined;
  } finally {
    await prep.close();
  }
  const nova = !salvo;

  const clock = new RelogioFlutuante(salvo?.instante ?? new Date(`${ANO_DA_PARTIDA}-01-01T12:00:00Z`), o.agoraReal);
  const fonte = new ReplaySource(() => clock.now(), undefined, { ano: ANO_DA_PARTIDA, dados: paraMemoria(fotos) });
  const ritmo = { tickMinutes: 15, activityPer3h: 0.25 };
  const servidor = await criarServidorEnsaio({
    databaseUrl: banco.url,
    inicio: clock.now(),
    clock,
    fonte,
    imports: [ModuloDaPartida],
    porta: portaApi,
    poolSize: 20,
    bots: ritmo,
  });
  const db = servidor.conexao.db;
  const escala = o.escala ?? 0.2;

  // ---- a temporada de 2026: carregada na primeira subida, reconstruída nas seguintes ----
  let carga: Carregado;
  let jogador: ContaEnsaio | null;
  if (nova) {
    const arquivo = arquivoDaSerieA(fotos);
    const primeiro = Math.min(...arquivo.matches.map((m: Match) => Date.parse(m.kickoff)));
    const datas = ipoDates(primeiro);
    clock.set(new Date(datas.opensAt - DIA));
    const nBots = Object.values(contagemDeBots(escala)).reduce((a, b) => a + b, 0);
    carga = await carregarTemporada(servidor, { ano: ANO_DA_PARTIDA, arquivo, adminApelido, offerSize: 150 * (nBots + 11) });
    await ligarBots(servidor, carga, escala);
  } else {
    carga = await reconstruirCarga(servidor, clock, adminApelido, fotos);
  }
  const bots = new AgenteDaPartida(servidor, ritmo);
  const condutor = new Condutor(servidor, carga, {
    aprovar: o.aprovarSozinho === true,
    liquidar: true,
    chanceDeRepetir: 0,
    ganchos: { agir: (p) => bots.agir(p) },
  });
  const salvar = async (instante: Date) => {
    await db.execute(
      sql`insert into public.partida_estado (id, instante, ano) values (1, ${instante.toISOString()}::timestamptz, ${ANO_DA_PARTIDA}) on conflict (id) do update set instante = excluded.instante, atualizado_em = now()`,
    );
  };
  if (nova) {
    // a partida começa na abertura do IPO (D5), com as ofertas abertas
    await condutor.ateExato(carga.ipo.opensAt);
    jogador = await cadastrarJogador(servidor, carga, clock, apelido);
    // os bots aparecem nos rankings desde o começo (o admin pode desligar depois, na tela de bots)
    const ligou = await servidor.app.inject({ method: "PATCH", url: `/admin/seasons/${carga.seasonId}`, payload: { botsInRankings: true }, headers: await carga.admin.auth() });
    if (ligou.statusCode >= 300) throw new Error(`bots nos rankings → ${ligou.statusCode}: ${ligou.body}`);
    await salvar(clock.now());
  } else {
    jogador = await contaPorApelido(db, apelido, clock);
    if (!jogador) throw new Error(`a conta de jogador "${apelido}" não existe no banco da partida (a partida foi criada com outro apelido)`);
  }

  const [maisNova] = (await db.execute<{ d: Date }>(sql`select max(baixado_em) as d from public.partida_dados`)).rows;
  let dadosDe: string | null = maisNova?.d ? new Date(maisNova.d).toISOString() : null;
  const relogio = new RelogioDaPartida({
    clock,
    condutor,
    fonte,
    salvar,
    laco: o.laco,
    atualizar: async () => {
      const r = await atualizarFotos(db, { hoje: new Date(), baixar: o.baixar });
      if (r.mudaram.length > 0) dadosDe = new Date().toISOString();
      return r;
    },
    dadosDe: () => dadosDe,
  });
  servidor.app.get(PorRelogio, { strict: false }).atual = relogio;

  let site: Server | undefined;
  let controle: Server | undefined;
  let controleUrl = "";
  if (!o.semPortas) {
    site = await servirSiteDaPartida(o.pastaDoSite, portaSite, { servidor, carga, jogador, clock, host });
    controle = await abrirControleDaPartida(relogio, portaControle, host);
    controleUrl = `http://${host}:${(controle.address() as AddressInfo).port}`;
  }

  return {
    servidor,
    relogio,
    clock,
    carga,
    condutor,
    bots,
    jogador,
    siteUrl: `http://${host}:${portaSite}`,
    controleUrl,
    nova,
    fechar: async () => {
      await relogio.pausar().catch(() => undefined);
      await new Promise<void>((ok) => (site ? site.close(() => ok()) : ok()));
      await new Promise<void>((ok) => (controle ? controle.close(() => ok()) : ok()));
      await servidor.fechar();
    },
  };
}

/** Convite e cadastro da conta de jogador pelas rotas de verdade, na abertura do IPO (ganha os R$ 100.000,00 da abertura). */
async function cadastrarJogador(servidor: ServidorEnsaio, carga: Carregado, clock: RelogioFlutuante, apelido: string): Promise<ContaEnsaio> {
  const email = `${apelido}@exemplo.com`;
  const convite = await servidor.app.inject({ method: "POST", url: "/admin/invites", payload: { emails: [email] }, headers: await carga.admin.auth() });
  if (convite.statusCode >= 300) throw new Error(`convite → ${convite.statusCode}: ${convite.body}`);
  const subject = randomUUID();
  const token = await tokenFor({ subject, email, at: clock.now(), expiresIn: VALIDADE_DO_TOKEN_S });
  const res = await servidor.app.inject({ method: "POST", url: "/me", payload: { nickname: apelido, acceptTerms: true }, headers: { authorization: `Bearer ${token}` } });
  if (res.statusCode >= 300) throw new Error(`cadastro de ${apelido} → ${res.statusCode}: ${res.body}`);
  const conta = await contaPorApelido(servidor.conexao.db, apelido, clock);
  return conta!;
}

/** A carga de uma partida que já existe: lê do banco o que a primeira subida criou. */
async function reconstruirCarga(servidor: ServidorEnsaio, clock: RelogioFlutuante, adminApelido: string, fotos: Awaited<ReturnType<typeof fotosMaisNovas>>): Promise<Carregado> {
  const db = servidor.conexao.db;
  const [temporada] = await db.select().from(seasons).where(eq(seasons.year, ANO_DA_PARTIDA));
  if (!temporada?.firstKickoff || !temporada.offerSize) throw new Error("o banco da partida não tem a temporada de 2026: zere a partida (npm run partida:zerar)");
  const admin = await contaPorApelido(db, adminApelido, clock);
  if (!admin) throw new Error(`a conta de admin "${adminApelido}" não existe no banco da partida`);
  const linhas = await db.select({ id: clubs.id, ticker: clubs.ticker }).from(clubs);
  const arquivo = arquivoDaSerieA(fotos);
  const datas = ipoDates(temporada.firstKickoff.getTime());
  return {
    seasonId: temporada.id,
    year: ANO_DA_PARTIDA,
    admin,
    clubIds: new Map(linhas.map((c) => [c.ticker!, c.id])),
    tickers: arquivo.clubs.map((c) => c.id),
    firstKickoff: temporada.firstKickoff,
    ipo: { opensAt: new Date(datas.opensAt), closesAt: new Date(datas.closesAt), tradingOpensAt: new Date(datas.tradingOpensAt) },
    offerSize: temporada.offerSize,
  };
}

/**
 * O site estático da partida, no mesmo processo, mais as páginas `/entrar/jogador` e `/entrar/admin`: o login falso do site
 * (`fake-auth-client`) lê o token do `localStorage`, e aqui o servidor o emite e põe lá. Só em 127.0.0.1.
 */
async function servirSiteDaPartida(
  pasta: string,
  porta: number,
  ctx: { servidor: ServidorEnsaio; carga: Carregado; jogador: ContaEnsaio; clock: RelogioFlutuante; host: string },
): Promise<Server> {
  const estatico = comRelogioNoSite(manipuladorDoSite(pasta), ctx.clock);
  const http = createServer(async (req, res) => {
    const caminho = (req.url ?? "/").split("?")[0]!;
    if (caminho === "/__hora") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return void res.end(JSON.stringify({ sim: ctx.clock.now().getTime(), run: ctx.clock.andando }));
    }
    const quem = /^\/entrar\/(jogador|admin)$/.exec(caminho)?.[1];
    if (!quem) return estatico(req, res);
    try {
      const conta = quem === "admin" ? ctx.carga.admin.conta : ctx.jogador.conta;
      const token = await tokenFor({ subject: conta.subject, email: conta.email, at: ctx.clock.now(), expiresIn: VALIDADE_DO_TOKEN_S });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      // o token só passa por aqui (loopback); a página guarda no localStorage do site e vai para a tela inicial
      res.end(
        `<!doctype html><meta charset="utf-8"><title>Entrando</title><p>Entrando como ${quem}…</p><script>` +
          `try{localStorage.setItem("futbolsa:e2e:token",${JSON.stringify(token)});localStorage.setItem("futbolsa:e2e:ultimo-login",String(Date.now()))}catch(e){document.body.textContent="o navegador bloqueou o localStorage"}` +
          `location.replace(${JSON.stringify(quem === "admin" ? "/admin" : "/")})</script>`,
      );
    } catch (erro) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(`não consegui entrar: ${(erro as Error).message}`);
    }
  });
  await new Promise<void>((ok) => http.listen(porta, ctx.host, ok));
  return http;
}

/**
 * O site decide pelo relógio do navegador (`Date.now()`) se o IPO aceita ofertas e se o mercado está aberto. Na partida o jogo
 * está em 2026-01 e o navegador em outro dia: cada página HTML servida ganha, no começo, um script que troca `Date` pelo relógio
 * da partida (parado quando pausado, andando junto quando em tempo real) e o atualiza de 2 em 2 segundos por `/__hora`.
 */
function scriptDoRelogio(clock: RelogioFlutuante): string {
  const inicial = JSON.stringify({ sim: clock.now().getTime(), run: clock.andando });
  return (
    "<script>(function(){var R=Date,N=R.now.bind(R),e=" +
    inicial +
    ";e.real=N();function a(){return e.run?e.sim+(N()-e.real):e.sim}" +
    "function F(){if(!(this instanceof F))return new R(a()).toString();if(arguments.length===0)return new R(a());return new (Function.prototype.bind.apply(R,[null].concat([].slice.call(arguments))))()}" +
    "F.prototype=R.prototype;F.now=a;F.parse=R.parse;F.UTC=R.UTC;window.Date=F;" +
    "function u(){fetch('/__hora',{cache:'no-store'}).then(function(r){return r.json()}).then(function(j){e={sim:j.sim,run:j.run,real:N()}}).catch(function(){})}" +
    "setInterval(u,2000);document.addEventListener('visibilitychange',u)})()</script>"
  );
}

type Atendente = (req: IncomingMessage, res: ServerResponse) => void;

/** Põe o script do relógio no começo das páginas HTML do site. */
function comRelogioNoSite(atender: Atendente, clock: RelogioFlutuante): Atendente {
  return (req, res) => {
    const r = res as unknown as { writeHead: (...a: unknown[]) => unknown };
    const writeHead = r.writeHead.bind(res);
    const write = res.write.bind(res) as (...a: unknown[]) => boolean;
    const end = res.end.bind(res) as (...a: unknown[]) => unknown;
    let html = false;
    const pedacos: Buffer[] = [];
    r.writeHead = (status: unknown, headers?: unknown) => {
      html = String((headers as Record<string, unknown> | undefined)?.["content-type"] ?? "").startsWith("text/html") && status === 200;
      return writeHead(status, headers);
    };
    res.write = ((c: unknown, ...resto: unknown[]) => (html ? (pedacos.push(Buffer.from(c as string)), true) : write(c, ...resto))) as typeof res.write;
    res.end = ((c?: unknown, ...resto: unknown[]) => {
      if (!html) return end(c, ...resto);
      if (c) pedacos.push(Buffer.from(c as string));
      return end(Buffer.concat(pedacos).toString("utf8").replace(/<head>/i, (m) => m + scriptDoRelogio(clock)));
    }) as typeof res.end;
    atender(req, res);
  };
}

/**
 * A porta de controle do terminal (só local; quem manda `Origin` é recusado, para uma página aberta no navegador não mexer no
 * relógio): `GET /estado` e `POST /relogio` com o mesmo corpo da rota do admin.
 */
async function abrirControleDaPartida(relogio: RelogioDaPartida, porta: number, host: string): Promise<Server> {
  const http = createServer(async (req, res) => {
    const responder = (status: number, corpo: unknown) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(corpo));
    };
    if (req.headers.origin) return responder(403, { erro: "a porta de controle não atende navegador" });
    try {
      if (req.method === "GET" && req.url === "/estado") return responder(200, relogio.estado());
      if (req.method === "POST" && req.url === "/relogio") {
        const partes: Buffer[] = [];
        for await (const parte of req) partes.push(parte as Buffer);
        const pedido = JSON.parse(Buffer.concat(partes).toString("utf8") || "{}") as Pedido;
        return responder(200, await relogio.pedir(pedido));
      }
      return responder(404, { erro: "rota desconhecida" });
    } catch (erro) {
      const status = (erro as { status?: number }).status ?? 500;
      responder(status, { erro: (erro as Error).message });
    }
  });
  await new Promise<void>((ok) => http.listen(porta, host, ok));
  return http;
}

