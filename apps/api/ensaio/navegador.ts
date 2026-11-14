import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import pg from "pg";
import { sql } from "drizzle-orm";
import { runMigrations } from "../src/infra/db/migrate.js";
import { tokenFor } from "../test/support/auth.js";
import { carregarTemporada2025, type Carregado } from "./carregar.js";
import { Condutor } from "./condutor.js";
import { recusarBancoNaoLocal } from "./guardas.js";
import { abrirControle, type Cenario, criarServidorEnsaio, type ServidorEnsaio } from "./servidor.js";

/**
 * O servidor do navegador (T19, P8 do Plano do ensaio, carga e testes no navegador): a API inteira com o relógio de teste, o
 * site de teste (`apps/web/out-e2e`, arquivos estáticos) e uma porta de controle local para o Playwright preparar cenários e
 * avançar o tempo. Mora em `ensaio/`, fora de `src/` e da imagem Docker: nada daqui vai à produção (guarda em `guardas.test.ts`).
 *
 * Os endereços são fixos porque o site de teste foi construído apontando para eles (`NEXT_PUBLIC_API_URL`), e o `WEB_ORIGIN`
 * da API é o do site, como em produção (o CORS e o WebSocket são os de verdade).
 */

export interface OpcoesNavegador {
  databaseUrl: string;
  pastaDoSite: string;
  portaApi: number;
  portaSite: number;
  portaControle: number;
}

export const PORTAS_PADRAO = { api: 3100, site: 3101, controle: 3102 } as const;
const NOME_DO_BANCO = "futbolsa_e2e";

/** O banco do navegador tem nome fixo: o servidor é morto à força pelo Playwright, sem chance de apagar nada ao sair. */
async function recriarBanco(urlBase: string): Promise<string> {
  recusarBancoNaoLocal(urlBase);
  const admin = new pg.Client({ connectionString: urlBase });
  await admin.connect();
  try {
    await admin.query(`drop database if exists "${NOME_DO_BANCO}" with (force)`);
    await admin.query(`create database "${NOME_DO_BANCO}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(urlBase);
  url.pathname = `/${NOME_DO_BANCO}`;
  await runMigrations(url.toString());
  return url.toString();
}

const TIPOS: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".png": "image/png",
};

/** Arquivos estáticos do export do Next: `/mercado` serve `mercado.html`, como a hospedagem do site faz. */
function servirSite(pasta: string, porta: number): Promise<Server> {
  const raiz = resolve(pasta);
  const http = createServer((req, res) => {
    const caminho = decodeURIComponent((req.url ?? "/").split("?")[0]!);
    const candidatos = [caminho, `${caminho}.html`, join(caminho, "index.html")].map((c) => normalize(join(raiz, c)));
    const achado = candidatos.find((c) => c.startsWith(raiz) && existsSync(c) && statSync(c).isFile());
    if (!achado) {
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
      createReadStream(join(raiz, "404.html")).on("error", () => res.end("não achei")).pipe(res);
      return;
    }
    res.writeHead(200, { "content-type": TIPOS[extname(achado)] ?? "application/octet-stream" });
    createReadStream(achado).pipe(res);
  });
  return new Promise((ok) => http.listen(porta, "127.0.0.1", () => ok(http)));
}

export type Fase = "preparando" | "ipo-aberto" | "negociacao";

export interface Navegador {
  servidor: ServidorEnsaio;
  controleUrl: string;
  fechar(): Promise<void>;
}

function safeJson(texto: string): unknown {
  try {
    return JSON.parse(texto);
  } catch {
    return texto;
  }
}

export async function subirNavegador(o: OpcoesNavegador): Promise<Navegador> {
  process.env.WEB_ORIGIN = `http://127.0.0.1:${o.portaSite}`;
  const url = await recriarBanco(o.databaseUrl);
  const servidor = await criarServidorEnsaio({
    databaseUrl: url,
    porta: o.portaApi,
    inicio: new Date("2025-03-01T12:00:00Z"),
    curta: { rodadas: 2 },
    // sem bots: o navegador confere o que um jogador vê, e bots mexeriam nos números
    bots: { tickMinutes: 180, activityPer3h: 0 },
  });
  const site = await servirSite(o.pastaDoSite, o.portaSite);
  let carga: Carregado | undefined;
  let condutor: Condutor | undefined;
  const db = servidor.conexao.db;
  const apelidos = new Map<string, { subject: string; email: string }>();

  const chamar = async (method: string, rota: string, payload: object | undefined, auth: { authorization: string }) => {
    const res = await servidor.app.inject({ method: method as "POST", url: rota, payload, headers: auth });
    return { status: res.statusCode, corpo: res.body ? safeJson(res.body) : null };
  };
  const tokenDe = (subject: string, email: string) => tokenFor({ subject, email, at: servidor.clock.now(), expiresIn: 30 * 86_400 });

  const avancar = async (ate: Date) => {
    if (!condutor) throw new Error("chame /cenario/mundo antes");
    await condutor.ateExato(ate);
  };

  const cadastrar = async (apelido: string) => {
    if (!carga) throw new Error("chame /cenario/mundo antes");
    const email = `${apelido}@exemplo.com`;
    const convite = await chamar("POST", "/admin/invites", { emails: [email] }, await carga.admin.auth());
    if (convite.status >= 300) throw new Error(`convite → ${convite.status}: ${JSON.stringify(convite.corpo)}`);
    const subject = randomUUID();
    const token = await tokenDe(subject, email);
    const r = await chamar("POST", "/me", { nickname: apelido, acceptTerms: true }, { authorization: `Bearer ${token}` });
    if (r.status >= 300) throw new Error(`cadastro de ${apelido} → ${r.status}: ${JSON.stringify(r.corpo)}`);
    apelidos.set(apelido, { subject, email });
    return { apelido, email, subject, token };
  };

  /** Apaga tudo e recomeça: o relógio volta a 2025-03-01 e a temporada é recarregada pelas rotas do admin. */
  const reiniciar = async (fase: Fase, offerSize: number, jogadores: string[] = []) => {
    const tabelas = await db.execute<{ tablename: string }>(sql`select tablename from pg_tables where schemaname = 'futbolsa'`);
    const lista = tabelas.rows.map((t) => `futbolsa."${t.tablename}"`).join(", ");
    // o histórico é só de acréscimo (gatilhos recusam TRUNCATE): o papel de réplica desliga os gatilhos só nesta transação
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx.execute(sql.raw(`truncate ${lista} restart identity cascade`));
    });
    apelidos.clear();
    servidor.clock.set(new Date("2025-03-01T12:00:00Z"));
    carga = await carregarTemporada2025(servidor, { offerSize });
    condutor = new Condutor(servidor, carga, { aprovar: true, chanceDeRepetir: 0 });
    servidor.clock.set(new Date(carga.ipo.opensAt.getTime() - 86_400_000));
    if (fase !== "preparando") await avancar(new Date(carga.ipo.opensAt.getTime() + 60 * 60_000));
    // quem se cadastra com as ofertas abertas recebe os R$ 100.000,00 da abertura (Conta e login 13)
    if (fase !== "preparando") for (const apelido of jogadores) await cadastrar(apelido);
    if (fase === "negociacao") {
      // um semeador oferta em todos os clubes (o IPO precisa de demanda para ter ações e preço) e o IPO fecha e liquida
      const semeador = await cadastrar("semeador");
      const auth = { authorization: `Bearer ${semeador.token}` };
      const painel = (await chamar("GET", "/ipo", undefined, auth)).corpo as { clubs?: Array<{ ticker: string; band?: { ceiling: number } | null }> };
      for (const ticker of carga.tickers) {
        const teto = painel.clubs?.find((c) => c.ticker === ticker)?.band?.ceiling ?? 5000;
        const r = await chamar("PUT", `/ipo/bids/${ticker}`, { quantity: Math.max(1, Math.floor(400_000 / teto)), maxPrice: teto, expect: "new" }, auth);
        if (r.status >= 300) throw new Error(`oferta do semeador em ${ticker} → ${r.status}: ${JSON.stringify(r.corpo)}`);
      }
      await avancar(new Date(carga.ipo.tradingOpensAt.getTime() + 60 * 60_000));
    }
    return { seasonId: carga.seasonId, tickers: carga.tickers, ipo: carga.ipo, agora: servidor.clock.now().toISOString() };
  };

  const cenarios: Record<string, Cenario> = {
    mundo: async (corpo) => {
      const { fase = "negociacao", offerSize = 150_000, jogadores = [] } = corpo as { fase?: Fase; offerSize?: number; jogadores?: string[] };
      return reiniciar(fase, offerSize, jogadores);
    },
    /** Convida o e-mail, cadastra o apelido e devolve o token de teste (válido por 30 dias do relógio simulado). */
    jogador: async (corpo) => cadastrar((corpo as { apelido: string }).apelido),
    /** Devolve o token de quem ainda não escolheu apelido (a tela de cadastro), sem criar a conta; convida o e-mail, salvo com `semConvite`. */
    convidado: async (corpo) => {
      const { email, semConvite = false } = corpo as { email: string; semConvite?: boolean };
      if (!semConvite) {
        const convite = await chamar("POST", "/admin/invites", { emails: [email] }, await carga!.admin.auth());
        if (convite.status >= 300) throw new Error(`convite → ${convite.status}: ${JSON.stringify(convite.corpo)}`);
      }
      return { email, token: await tokenDe(randomUUID(), email) };
    },
    /** Token novo de quem já existe (o relógio simulado andou, o token antigo pode ter vencido). */
    token: async (corpo) => {
      const { apelido } = corpo as { apelido: string };
      if (apelido === "admin") return { token: await tokenDe(carga!.admin.conta.subject, carga!.admin.conta.email), email: carga!.admin.conta.email };
      const p = apelidos.get(apelido);
      if (!p) throw new Error(`jogador desconhecido: ${apelido}`);
      return { token: await tokenDe(p.subject, p.email), email: p.email };
    },
    /** Roda as tarefas (como em produção) até o instante dado, ou até um marco: `fechamento-ipo`, `abertura-negociacao`. */
    "avancar-ate": async (corpo) => {
      const { para, depoisDe = 0 } = corpo as { para: string; depoisDe?: number };
      const marcos: Record<string, Date | undefined> = { "fechamento-ipo": carga?.ipo.closesAt, "abertura-negociacao": carga?.ipo.tradingOpensAt };
      const alvo = marcos[para] ?? new Date(para);
      await avancar(new Date(alvo.getTime() + depoisDe));
      return { agora: servidor.clock.now().toISOString() };
    },
  };
  const controle = await abrirControle(servidor, cenarios, o.portaControle);
  return {
    servidor,
    controleUrl: controle.url,
    fechar: async () => {
      await controle.fechar();
      await new Promise<void>((ok) => site.close(() => ok()));
      await servidor.fechar();
    },
  };
}
