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

/** Põe o token no navegador antes de a página carregar: o login falso do site de teste o lê do `localStorage`. */
export async function entrarComo(alvo: Page | BrowserContext, apelido: string): Promise<void> {
  const { token } = await tokenDe(apelido);
  await alvo.addInitScript((t) => window.localStorage.setItem("futbolsa:e2e:token", t), token);
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
