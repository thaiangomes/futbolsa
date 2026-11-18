/**
 * Conversão do placar da API pública da ESPN (sem chave, sem documentação nem termos publicados: serve para o teste da
 * partida e para calibrar, não para o jogo público) para o formato de partidas do FutBolsa (`data/README.md`).
 * Pura: sem rede e sem disco. O script `scripts/fetch-espn-copa.ts` baixa e grava; os testes usam um trecho congelado.
 */
import { IPO_POSITIONS_2026, clubIdFromName, clubName } from "./clubs.js";
import { markOutOfWindow, type SeasonFile } from "./season.js";
import type { Match } from "../engine/types.js";

export interface EspnCompetitor {
  homeAway: string;
  score?: string;
  winner?: boolean;
  team: { displayName: string };
}
export interface EspnEvent {
  id: string;
  date: string;
  season: { slug: string };
  competitions: Array<{ status: { type: { name: string } }; competitors: EspnCompetitor[] }>;
}

export interface CompeticaoEspn {
  /** Liga na ESPN (`bra.1`). */
  league: string;
  /** Código da competição no motor (campo `competition` dos arquivos). */
  competition: string;
  /** Prefixo do arquivo: `data/<arquivo>-<ano>.json`. */
  arquivo: string;
  tipo: "liga" | "copa";
}

export const COMPETICOES_ESPN: Record<string, CompeticaoEspn> = {
  "brasileirao-a": { league: "bra.1", competition: "brasileirao-a", arquivo: "brasileirao", tipo: "liga" },
  "brasileirao-b": { league: "bra.2", competition: "brasileirao-b", arquivo: "brasileirao-b", tipo: "liga" },
  "copa-do-brasil": { league: "bra.copa_do_brazil", competition: "copa-do-brasil", arquivo: "copa-do-brasil", tipo: "copa" },
  libertadores: { league: "conmebol.libertadores", competition: "libertadores", arquivo: "libertadores", tipo: "copa" },
  "sul-americana": { league: "conmebol.sudamericana", competition: "sul-americana", arquivo: "sul-americana", tipo: "copa" },
};

/** Endereço do placar do ano inteiro (`dates=AAAA&limit=1000` devolve a temporada numa chamada). */
export function urlDoPlacar(league: string, ano: number): string {
  return `https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/scoreboard?dates=${ano}&limit=1000`;
}

/** Fases da ESPN para os nomes do motor (as mesmas da fonte de resultados da API). */
const FASES: Record<string, string> = {
  "first-round": "1a-fase",
  "second-round": "2a-fase",
  "third-round": "3a-fase",
  "fourth-round": "4a-fase",
  "fifth-round": "5a-fase",
  "first-stage": "pre-1",
  "second-stage": "pre-2",
  "third-stage": "pre-3",
  "group-stage": "grupos",
  "knockout-round-playoffs": "playoffs",
  "round-of-16": "oitavas",
  quarterfinals: "quartas",
  semifinals: "semifinal",
  final: "final",
  finals: "final",
};

const slug = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Clubes de fora do jogo ganham um id próprio ("EXT-LANUS"): não têm ações, mas os jogos decidem as fases. */
function clubId(name: string): string {
  try {
    return clubIdFromName(name);
  } catch {
    return `EXT-${slug(name)}`;
  }
}

/** UTC da ESPN ("2026-02-25T20:00Z") para o horário de Brasília. */
export function brasilia(utc: string): string {
  return `${new Date(Date.parse(utc) - 3 * 3600e3).toISOString().slice(0, 19)}-03:00`;
}

export interface ResumoDaConversao {
  /** Eventos que a ESPN devolveu. */
  eventos: number;
  jogados: number;
  porJogar: number;
  /** Eventos marcados como adiados pela ESPN. */
  adiados: number;
  /** Adiados que a ESPN já remarcou e jogou: o evento antigo é descartado e o jogo remarcado leva a marca `postponed`. */
  adiadosRemarcados: number;
  cancelados: number;
  /** Início do último jogo terminado (ISO de Brasília). */
  ultimoJogado: string | null;
}

export interface Convertido {
  arquivo: SeasonFile | { season: number; competition: string; source: string; matches: Match[] };
  resumo: ResumoDaConversao;
}

const estado = (nome: string): "finished" | "postponed" | "cancelled" | "live" | "scheduled" => {
  if (/^STATUS_(FULL_TIME|FINAL)/.test(nome)) return "finished";
  if (nome === "STATUS_POSTPONED") return "postponed";
  if (nome === "STATUS_CANCELED" || nome === "STATUS_ABANDONED") return "cancelled";
  // jogo em andamento: continua agendado (sem placar final), mas o placar parcial é guardado
  if (/^STATUS_(IN_PROGRESS|FIRST_HALF|SECOND_HALF|HALFTIME|END_PERIOD)$/.test(nome)) return "live";
  return "scheduled";
};

const HORA_MS = 3_600_000;

/**
 * A rodada de cada jogo dos pontos corridos, já que a ESPN não a informa. Os jogos de uma rodada acontecem juntos: o
 * calendário se divide em janelas (um intervalo de mais de 40 horas ou um clube repetido abre outra) e as janelas cheias
 * são as rodadas, numeradas na ordem. Os jogos de janelas pequenas (adiados e antecipados, jogados fora da rodada) vão para
 * a primeira rodada em que os dois clubes ainda não jogaram; o que não couber em nenhuma vai para a rodada mais próxima no
 * tempo. Como a fonte de resultados da API, pode errar a rodada de um adiado; o admin corrige.
 */
export function derivarRodadas<T>(jogos: Array<{ chave: T; t: number; home: string; away: string }>): Map<T, number> {
  const ordenados = [...jogos].sort((a, b) => a.t - b.t);
  interface Janela {
    jogos: typeof ordenados;
    clubes: Set<string>;
    ultimo: number;
  }
  const janelas: Janela[] = [];
  let atual: Janela | undefined;
  for (const j of ordenados) {
    if (!atual || j.t - atual.ultimo > 40 * HORA_MS || atual.clubes.has(j.home) || atual.clubes.has(j.away)) {
      atual = { jogos: [], clubes: new Set(), ultimo: j.t };
      janelas.push(atual);
    }
    atual.jogos.push(j);
    atual.clubes.add(j.home);
    atual.clubes.add(j.away);
    atual.ultimo = j.t;
  }
  const maior = Math.max(0, ...janelas.map((w) => w.jogos.length));
  const cheias = janelas.filter((w) => w.jogos.length >= Math.ceil(maior * 0.6));
  const sobras = janelas.filter((w) => w.jogos.length < Math.ceil(maior * 0.6)).flatMap((w) => w.jogos);
  const resultado = new Map<T, number>();
  cheias.forEach((w, k) => w.jogos.forEach((j) => resultado.set(j.chave, k + 1)));
  for (const j of sobras.sort((a, b) => a.t - b.t)) {
    let k = cheias.findIndex((w) => w.jogos.length < maior && !w.clubes.has(j.home) && !w.clubes.has(j.away));
    if (k < 0) {
      // a rodada mais próxima no tempo
      k = 0;
      let melhor = Infinity;
      cheias.forEach((w, i) => {
        const dist = Math.min(...w.jogos.map((x) => Math.abs(x.t - j.t)));
        if (dist < melhor) [melhor, k] = [dist, i];
      });
    }
    const w = cheias[k]!;
    w.jogos.push(j);
    w.clubes.add(j.home);
    w.clubes.add(j.away);
    resultado.set(j.chave, k + 1);
  }
  return resultado;
}

/**
 * Converte os eventos de uma competição. Nos pontos corridos a ESPN não traz a rodada (`derivarRodadas`); o jogo remarcado ocupa a rodada do adiado que ele substitui.
 */
export function converterEspn(chave: string, eventos: EspnEvent[], ano: number, baixadoEm: string): Convertido {
  const cfg = COMPETICOES_ESPN[chave];
  if (!cfg) throw new Error(`Competição desconhecida: ${chave}`);
  const liga = cfg.tipo === "liga";
  const unicos = [...new Map(eventos.map((e) => [e.id, e])).values()]
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  interface Item {
    e: EspnEvent;
    home: string;
    away: string;
    estado: ReturnType<typeof estado>;
    fase: string | undefined;
    homeC: EspnCompetitor;
    awayC: EspnCompetitor;
    rodada?: number;
  }
  const itens: Item[] = unicos.map((e) => {
    const c = e.competitions[0]!;
    const homeC = c.competitors.find((x) => x.homeAway === "home")!;
    const awayC = c.competitors.find((x) => x.homeAway === "away")!;
    const slugFase = e.season.slug.toLowerCase();
    let fase: string | undefined;
    if (!liga) {
      fase = FASES[slugFase];
      if (!fase) throw new Error(`Fase desconhecida: "${e.season.slug}"`);
    }
    return { e, home: clubId(homeC.team.displayName), away: clubId(awayC.team.displayName), estado: estado(c.status.type.name), fase, homeC, awayC };
  });

  // adiado que a ESPN já remarcou: o mesmo confronto (fase, mandante e visitante) aparece de novo, com outra data
  const chaveDe = (i: Item) => `${i.fase ?? ""}|${i.home}|${i.away}`;
  const remarcados = new Map<string, Item>();
  for (const i of itens) if (i.estado !== "postponed") remarcados.set(chaveDe(i), i);
  const substituidos = new Map<Item, Item>(); // adiado antigo → jogo remarcado
  for (const i of itens) {
    if (i.estado !== "postponed") continue;
    const novo = remarcados.get(chaveDe(i));
    if (novo) substituidos.set(i, novo);
  }
  const jogosRemarcados = new Set(substituidos.values());

  if (liga) {
    const base = itens.filter((i) => !jogosRemarcados.has(i));
    const rodadas = derivarRodadas(base.map((i) => ({ chave: i, t: Date.parse(i.e.date), home: i.home, away: i.away })));
    for (const i of base) i.rodada = rodadas.get(i);
    for (const [antigo, novo] of substituidos) novo.rodada = antigo.rodada; // o remarcado ocupa a rodada do adiado
  }

  const resumo: ResumoDaConversao = { eventos: unicos.length, jogados: 0, porJogar: 0, adiados: 0, adiadosRemarcados: substituidos.size, cancelados: 0, ultimoJogado: null };
  const partidas: Match[] = [];
  for (const i of itens) {
    if (i.estado === "postponed") {
      resumo.adiados++;
      if (substituidos.has(i)) continue; // vale o jogo remarcado
    }
    const status = i.estado === "finished" ? "finished" : i.estado === "cancelled" ? "cancelled" : "scheduled";
    if (status === "finished" && (i.homeC.score === undefined || i.awayC.score === undefined)) throw new Error(`Jogo encerrado sem placar: ${i.e.id}`);
    const kickoff = brasilia(i.e.date);
    const m: Match = {
      id: liga
        ? `${ano}-${chave === "brasileirao-a" ? "" : "brasileirao-b-"}r${String(i.rodada).padStart(2, "0")}-${i.home}-${i.away}`
        : `${ano}-${chave}-${i.fase}-${i.e.date.slice(0, 10)}-${i.home}-${i.away}`,
      competition: cfg.competition,
      ...(liga ? { round: i.rodada } : { phase: i.fase }),
      kickoff,
      home: i.home,
      away: i.away,
      homeGoals: status === "finished" ? Number(i.homeC.score) : null,
      awayGoals: status === "finished" ? Number(i.awayC.score) : null,
      status,
    };
    if (i.estado === "live" && i.homeC.score !== undefined && i.awayC.score !== undefined) m.parcial = { homeGoals: Number(i.homeC.score), awayGoals: Number(i.awayC.score) };
    // adiado sem data nova: continua agendado e marcado, e paga na rodada em que for disputado
    if (i.estado === "postponed") m.postponed = true;
    if (!liga) {
      // pênaltis e final: vale quem a ESPN marca como vencedor
      const nome = i.e.competitions[0]!.status.type.name;
      const winner = i.homeC.winner ? i.home : i.awayC.winner ? i.away : undefined;
      if (winner && status === "finished" && (nome === "STATUS_FINAL_PEN" || i.fase === "final")) m.winner = winner;
    }
    if (status === "finished") {
      resumo.jogados++;
      if (!resumo.ultimoJogado || kickoff > resumo.ultimoJogado) resumo.ultimoJogado = kickoff;
    } else if (status === "cancelled") resumo.cancelados++;
    else resumo.porJogar++;
    partidas.push(m);
  }
  partidas.sort((a, b) => a.kickoff.localeCompare(b.kickoff) || a.id.localeCompare(b.id));
  const ids = new Set<string>();
  for (const m of partidas) {
    if (ids.has(m.id)) throw new Error(`id repetido: ${m.id}`);
    ids.add(m.id);
  }
  const matches = liga ? markOutOfWindow(partidas) : partidas;
  // o adiado sem data nova continua marcado, mesmo dentro da janela
  for (const m of matches) if (partidas.find((p) => p.id === m.id)?.postponed) m.postponed = true;
  const source = `API pública da ESPN (${cfg.league}), https://site.api.espn.com, baixado em ${baixadoEm}`;
  const base = { season: ano, competition: cfg.competition, source };
  if (chave === "brasileirao-a" && ano === 2026) {
    const clubs = Object.entries(IPO_POSITIONS_2026)
      .sort((a, b) => a[1] - b[1])
      .map(([id, ipoPosition]) => ({ id, name: clubName(id), division: "A" as const, ipoPosition }));
    const naLista = new Set(clubs.map((c) => c.id));
    for (const m of matches) {
      if (!naLista.has(m.home) || !naLista.has(m.away)) throw new Error(`${m.id}: clube fora da Série A de ${ano}`);
    }
    return { arquivo: { ...base, clubs, matches }, resumo };
  }
  return { arquivo: { ...base, matches }, resumo };
}
