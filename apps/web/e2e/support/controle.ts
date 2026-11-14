import type { BrowserContext, Page } from "@playwright/test";

/** Ajudantes dos testes do navegador (T19): a porta de controle do servidor, o login falso e o relógio. */
export const CONTROLE = "http://127.0.0.1:3102";
export const API = "http://127.0.0.1:3100";

export interface Mundo {
  seasonId: number;
  tickers: string[];
  ipo: { opensAt: string; closesAt: string; tradingOpensAt: string };
  agora: string;
}

export async function controle<T = Record<string, unknown>>(cenario: string, corpo: object = {}): Promise<T> {
  const res = await fetch(`${CONTROLE}/cenario/${cenario}`, { method: "POST", body: JSON.stringify(corpo) });
  const json = (await res.json()) as T & { erro?: string };
  if (!res.ok) throw new Error(`cenário ${cenario}: ${json.erro ?? res.status}`);
  return json;
}

/** Recomeça o mundo do servidor: temporada de 2025 carregada, no ponto pedido (padrão: negociação aberta). */
export function prepararCenario(fase: "preparando" | "ipo-aberto" | "negociacao" = "negociacao"): Promise<Mundo> {
  return controle<Mundo>("mundo", { fase });
}

/** Roda as tarefas até um instante (ISO) ou marco (`fechamento-ipo`, `abertura-negociacao`), como em produção. */
export async function avancarRelogio(para: string, depoisDeMs = 0): Promise<string> {
  return (await controle<{ agora: string }>("avancar-ate", { para, depoisDe: depoisDeMs })).agora;
}

export interface Jogador {
  apelido: string;
  email: string;
  token: string;
}

/** Convida, cadastra pela API e devolve o token de teste. */
export function criarJogador(apelido: string): Promise<Jogador> {
  return controle<Jogador>("jogador", { apelido });
}

/** Token novo de quem já existe (`admin` é o administrador do mundo). */
export function tokenDe(apelido: string): Promise<Jogador> {
  return controle<Jogador>("token", { apelido }).then((r) => ({ ...r, apelido }));
}

/**
 * O relógio do navegador acompanha o do jogo (2025-03 e adiante): o site decide pelo `Date.now()` do navegador se o IPO ainda
 * aceita ofertas e se o mercado está aberto. Chame de novo depois de `avancarRelogio` (a página já aberta segue o novo horário).
 */
const instalados = new WeakSet<object>();
export async function sincronizar(alvo: Page | BrowserContext): Promise<void> {
  const { agora } = (await (await fetch(`${CONTROLE}/hora`)).json()) as { agora: string };
  const hora = new Date(agora);
  if (instalados.has(alvo)) await alvo.clock.setSystemTime(hora);
  else {
    await alvo.clock.install({ time: hora });
    instalados.add(alvo);
  }
}

/** Põe o token no navegador antes de a página carregar: o login falso do site de teste o lê do `localStorage`. */
export async function entrarComo(alvo: Page | BrowserContext, apelido: string): Promise<void> {
  const { token } = await tokenDe(apelido);
  await entrarComToken(alvo, token);
}

/** Um contexto do navegador novo (outra pessoa, outro aparelho). */
export async function sairDoNavegador(page: Page): Promise<void> {
  await page.evaluate(() => window.localStorage.removeItem("futbolsa:e2e:token"));
}

/** Uma chamada da API como a pessoa (para preparar o que a tela vai mostrar). */
export async function api<T = unknown>(apelido: string, metodo: string, rota: string, corpo?: object): Promise<{ status: number; corpo: T }> {
  const { token } = await tokenDe(apelido);
  const res = await fetch(`${API}${rota}`, {
    method: metodo,
    headers: { authorization: `Bearer ${token}`, ...(corpo ? { "content-type": "application/json" } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const texto = await res.text();
  return { status: res.status, corpo: (texto ? JSON.parse(texto) : null) as T };
}

/** Token de alguém com login mas sem conta no jogo: convidado (vai ao cadastro) ou, com `semConvite`, sem o e-mail liberado. */
export function convidado(email: string, semConvite = false): Promise<{ email: string; token: string }> {
  return controle("convidado", { email, semConvite });
}

/** Põe um token qualquer no navegador antes de a página carregar. */
export async function entrarComToken(alvo: Page | BrowserContext, token: string): Promise<void> {
  await sincronizar(alvo);
  await alvo.addInitScript((t) => window.localStorage.setItem("futbolsa:e2e:token", t), token);
}

/** As contas de e-mail e senha que o login falso aceita (para as telas de entrar). */
export async function definirContas(alvo: Page | BrowserContext, contas: Record<string, { password: string; token: string }>): Promise<void> {
  await alvo.addInitScript((c) => window.localStorage.setItem("futbolsa:e2e:contas", JSON.stringify(c)), contas);
}
