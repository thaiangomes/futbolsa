import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import type { CompetitionCode } from "@futbolsa/contracts";
import { COMPETICOES_ESPN, converterEspn, finishTime, urlDoPlacar, type EspnEvent, type Match } from "@futbolsa/engine";
import type { Database } from "../src/infra/db/index.js";
import { DATA_DIR, type DadosEmMemoria } from "../ensaio/replay-source.js";
import type { ArquivoDaSerieA } from "../ensaio/carregar.js";

/**
 * Os dados da partida no banco (D4, `partida_dados`): uma foto por competição e por baixa, com a data da baixa. A primeira
 * partida parte da foto do repositório (`packages/engine/data/*-2026.json`); cada "atualizar" acrescenta as fotos que mudaram,
 * e vale a mais nova de cada competição. As fotos antigas ficam.
 */

export const ANO_DA_PARTIDA = 2026;

/** Competição da ESPN (nome dos arquivos do motor) para o código da API. */
export const CODIGO_DA_API: Record<string, CompetitionCode> = {
  "brasileirao-a": "brasileirao-a",
  "brasileirao-b": "brasileirao-b",
  "copa-do-brasil": "copa-do-brasil",
  libertadores: "libertadores",
  "sul-americana": "sulamericana",
};

export type Arquivo = { season: number; competition: string; source: string; matches: Match[]; clubs?: ArquivoDaSerieA["clubs"] };
export type Fotos = Record<string, Arquivo>;

const CHAVES = Object.keys(CODIGO_DA_API);

/** Semeia as fotos do repositório se o banco ainda não tem nenhuma (a data da baixa é a escrita no próprio arquivo). */
export async function semearFotos(db: Database): Promise<boolean> {
  const r = await db.execute<{ n: string }>(sql`select count(*)::text as n from public.partida_dados`);
  if (Number(r.rows[0]!.n) > 0) return false;
  for (const chave of CHAVES) {
    const arquivo = JSON.parse(readFileSync(join(DATA_DIR, `${COMPETICOES_ESPN[chave]!.arquivo}-${ANO_DA_PARTIDA}.json`), "utf8")) as Arquivo;
    const baixado = /baixado em (\d{4}-\d{2}-\d{2})/.exec(arquivo.source)?.[1] ?? "2026-11-15";
    await db.execute(sql`insert into public.partida_dados (competicao, baixado_em, dados) values (${chave}, ${baixado}::timestamptz, ${JSON.stringify(arquivo)}::jsonb)`);
  }
  return true;
}

/** A foto mais nova de cada competição. */
export async function fotosMaisNovas(db: Database): Promise<Fotos> {
  const r = await db.execute<{ competicao: string; dados: Arquivo }>(
    sql`select distinct on (competicao) competicao, dados from public.partida_dados order by competicao, baixado_em desc, id desc`,
  );
  const fotos: Fotos = {};
  for (const l of r.rows) fotos[l.competicao] = l.dados;
  for (const c of CHAVES) if (!fotos[c]) throw new Error(`o banco da partida não tem dados de ${c}`);
  return fotos;
}

export function paraMemoria(fotos: Fotos): DadosEmMemoria {
  return Object.fromEntries(CHAVES.map((c) => [CODIGO_DA_API[c]!, fotos[c]!.matches]));
}

export function arquivoDaSerieA(fotos: Fotos): ArquivoDaSerieA {
  const a = fotos["brasileirao-a"]!;
  if (!a.clubs) throw new Error("a foto da Série A não traz a lista de clubes");
  return { season: a.season, clubs: a.clubs, matches: a.matches };
}

/** O fim do último jogo terminado nas fotos (o limite do relógio). */
export function limiteDasFotos(fotos: Fotos): number | null {
  let ultimo: number | null = null;
  for (const c of CHAVES) for (const m of fotos[c]!.matches) if (m.status === "finished") ultimo = Math.max(ultimo ?? 0, finishTime(m));
  return ultimo;
}

export type Baixador = (url: string) => Promise<unknown>;

const baixarPadrao: Baixador = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`a ESPN respondeu ${res.status}`);
  return res.json();
};

export interface ResultadoDaAtualizacao {
  /** Competições com foto nova gravada. */
  mudaram: string[];
  limiteAntes: number | null;
  limiteDepois: number | null;
  fotos: Fotos;
}

/**
 * Baixa as 5 competições de novo, converte e grava a foto das que mudaram. Se qualquer download ou conversão falhar, não grava
 * nada: o estado fica como estava (critério 8).
 */
export async function atualizarFotos(db: Database, o: { hoje: Date; baixar?: Baixador }): Promise<ResultadoDaAtualizacao> {
  const baixar = o.baixar ?? baixarPadrao;
  const atuais = await fotosMaisNovas(db);
  const novas: Fotos = {};
  const baixadoEm = o.hoje.toISOString().slice(0, 10);
  try {
    for (const chave of CHAVES) {
      const corpo = (await baixar(urlDoPlacar(COMPETICOES_ESPN[chave]!.league, ANO_DA_PARTIDA))) as { events?: EspnEvent[] };
      novas[chave] = converterEspn(chave, corpo.events ?? [], ANO_DA_PARTIDA, baixadoEm).arquivo as Arquivo;
    }
  } catch (erro) {
    throw new Error(`não consegui atualizar os dados da ESPN: ${(erro as Error).message}`);
  }
  const mudaram = CHAVES.filter((c) => JSON.stringify(novas[c]!.matches) !== JSON.stringify(atuais[c]!.matches));
  for (const c of mudaram) {
    await db.execute(sql`insert into public.partida_dados (competicao, baixado_em, dados) values (${c}, ${o.hoje.toISOString()}::timestamptz, ${JSON.stringify(novas[c])}::jsonb)`);
  }
  const fotos = { ...atuais, ...Object.fromEntries(mudaram.map((c) => [c, novas[c]!])) };
  return { mudaram, limiteAntes: limiteDasFotos(atuais), limiteDepois: limiteDasFotos(fotos), fotos };
}
