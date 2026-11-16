import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLUBS, ipoDates, kickoffTime, type Match } from "@futbolsa/engine";
import { badgeColumns } from "../src/infra/db/club-badge.js";
import { clubs } from "../src/infra/db/schema/index.js";
import { type ContaEnsaio, criarConta } from "./contas.js";
import type { ServidorEnsaio } from "./servidor.js";

/**
 * Carregador da temporada de 2025 (T3): clubes, a temporada em preparação com a lista de clubes, a oferta, o primeiro jogo e as
 * tabelas das três copas confirmadas, tudo pelas rotas do admin, como o Thaian faria. Os jogos e a classificação não são
 * gravados aqui: entram pela importação, pela fonte de reprodução (`ReplaySource`), na primeira parada do condutor.
 */

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/engine/data");

/** O arquivo do Brasileirão Série A de uma temporada (`data/README.md`). */
export interface ArquivoDaSerieA {
  season: number;
  clubs: Array<{ id: string; ipoPosition: number }>;
  matches: Match[];
}

export interface Carregado {
  seasonId: number;
  year: number;
  admin: ContaEnsaio;
  clubIds: Map<string, number>;
  tickers: string[];
  firstKickoff: Date;
  ipo: { opensAt: Date; closesAt: Date; tradingOpensAt: Date };
  offerSize: number;
}

export interface OpcoesCarga {
  /** Ações ofertadas por clube. */
  offerSize: number;
  /** A temporada de outro ano (a partida de 2026): o arquivo da Série A vem de fora (o banco da partida) em vez do repositório. */
  ano?: number;
  arquivo?: ArquivoDaSerieA;
  /** Apelido do admin criado (padrão `admin_ensaio`). */
  adminApelido?: string;
  /** Um admin que já existe (a partida retomada): não cria outro. */
  admin?: ContaEnsaio;
}

/** O ensaio de 2025: o arquivo do repositório e o admin de teste. */
export async function carregarTemporada2025(servidor: ServidorEnsaio, opcoes: OpcoesCarga): Promise<Carregado> {
  return carregarTemporada(servidor, opcoes);
}

/**
 * Carrega uma temporada pelas rotas do admin: clubes, a temporada em preparação com a lista de clubes (a colocação do IPO vem
 * do arquivo: em 2026, a tabela final de 2025), a oferta, o primeiro jogo e as copas confirmadas.
 */
export async function carregarTemporada(servidor: ServidorEnsaio, opcoes: OpcoesCarga): Promise<Carregado> {
  const db = servidor.conexao.db;
  const ano = opcoes.ano ?? 2025;
  const arquivo = opcoes.arquivo ?? (JSON.parse(readFileSync(join(DATA_DIR, `brasileirao-${ano}.json`), "utf8")) as ArquivoDaSerieA);
  await db
    .insert(clubs)
    .values(CLUBS.map((c) => ({ ticker: c.id, name: c.name, ...badgeColumns(c.id) })))
    .onConflictDoNothing({ target: clubs.ticker });
  const linhas = await db.select({ id: clubs.id, ticker: clubs.ticker }).from(clubs);
  const clubIds = new Map(linhas.map((c) => [c.ticker!, c.id]));

  const admin = opcoes.admin ?? (await criarConta(db, servidor, { nickname: opcoes.adminApelido ?? "admin_ensaio", role: "admin" }));
  const chamar = async (method: "POST" | "PUT" | "PATCH", url: string, payload?: object) => {
    const res = await servidor.app.inject({ method, url, payload, headers: await admin.auth() });
    if (res.statusCode >= 300) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body}`);
    return res.json();
  };

  const year = arquivo.season;
  const season = (await chamar("POST", "/admin/seasons", { year })) as { id: number };
  await chamar("PUT", `/admin/seasons/${season.id}/clubs`, {
    clubs: arquivo.clubs.map((c) => ({ clubId: clubIds.get(c.id)!, division: "A", prevPlacement: c.ipoPosition })),
  });
  const firstKickoff = new Date(Math.min(...arquivo.matches.map(kickoffTime)));
  await chamar("PATCH", `/admin/seasons/${season.id}`, { offerSize: opcoes.offerSize, firstKickoff: firstKickoff.toISOString() });
  for (const copa of ["copa-do-brasil", "libertadores", "sulamericana"]) {
    await chamar("POST", `/admin/seasons/${season.id}/cups/${copa}/confirm`);
  }
  const datas = ipoDates(firstKickoff.getTime());
  return {
    seasonId: season.id,
    year,
    admin,
    clubIds,
    tickers: arquivo.clubs.map((c) => c.id),
    firstKickoff,
    ipo: { opensAt: new Date(datas.opensAt), closesAt: new Date(datas.closesAt), tradingOpensAt: new Date(datas.tradingOpensAt) },
    offerSize: opcoes.offerSize,
  };
}
