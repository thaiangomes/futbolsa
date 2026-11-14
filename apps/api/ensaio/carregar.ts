import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLUBS, ipoDates, kickoffTime, type Match } from "@futbolsa/engine";
import { clubs } from "../src/infra/db/schema/index.js";
import { type ContaEnsaio, criarConta } from "./contas.js";
import type { ServidorEnsaio } from "./servidor.js";

/**
 * Carregador da temporada de 2025 (T3): clubes, a temporada em preparação com a lista de clubes, a oferta, o primeiro jogo e as
 * tabelas das três copas confirmadas, tudo pelas rotas do admin, como o Thaian faria. Os jogos e a classificação não são
 * gravados aqui: entram pela importação, pela fonte de reprodução (`ReplaySource`), na primeira parada do condutor.
 */

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/engine/data");

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
}

export async function carregarTemporada2025(servidor: ServidorEnsaio, opcoes: OpcoesCarga): Promise<Carregado> {
  const db = servidor.conexao.db;
  const arquivo = JSON.parse(readFileSync(join(DATA_DIR, "brasileirao-2025.json"), "utf8")) as {
    season: number;
    clubs: Array<{ id: string; ipoPosition: number }>;
    matches: Match[];
  };
  await db
    .insert(clubs)
    .values(CLUBS.map((c) => ({ ticker: c.id, name: c.name })))
    .onConflictDoNothing({ target: clubs.ticker });
  const linhas = await db.select({ id: clubs.id, ticker: clubs.ticker }).from(clubs);
  const clubIds = new Map(linhas.map((c) => [c.ticker!, c.id]));

  const admin = await criarConta(db, servidor, { nickname: "admin_ensaio", role: "admin" });
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
