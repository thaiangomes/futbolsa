import { readFileSync } from "node:fs";
import { kickoffTime, type Club, type Match } from "../engine/types.js";

/** Arquivo de temporada (data/*.json). O formato está em data/README.md. */
export interface SeasonFile {
  season: number;
  competition: string;
  source: string;
  clubs: Array<Club & { ipoPosition: number }>;
  matches: Match[];
}

export function loadSeason(path: string): SeasonFile {
  const data = JSON.parse(readFileSync(path, "utf8")) as SeasonFile;
  validateSeason(data);
  return data;
}

export function validateSeason(data: SeasonFile): void {
  const problems: string[] = [];
  if (!Number.isInteger(data.season)) problems.push("season ausente");
  if (!Array.isArray(data.clubs) || data.clubs.length === 0) problems.push("clubs vazio");
  if (!Array.isArray(data.matches) || data.matches.length === 0) problems.push("matches vazio");
  const clubIds = new Set(data.clubs?.map((c) => c.id));
  const positions = new Set<number>();
  for (const c of data.clubs ?? []) {
    if (!Number.isInteger(c.ipoPosition) || c.ipoPosition < 1 || c.ipoPosition > 20) {
      problems.push(`${c.id}: ipoPosition deve ser 1..20`);
    }
    positions.add(c.ipoPosition);
  }
  const ids = new Set<string>();
  for (const m of data.matches ?? []) {
    if (ids.has(m.id)) problems.push(`id repetido: ${m.id}`);
    ids.add(m.id);
    if (!clubIds.has(m.home) || !clubIds.has(m.away)) problems.push(`${m.id}: clube fora da lista`);
    if (Number.isNaN(kickoffTime(m))) problems.push(`${m.id}: kickoff inválido`);
    if (m.status === "finished" && (m.homeGoals === null || m.awayGoals === null)) {
      problems.push(`${m.id}: jogo encerrado sem placar`);
    }
  }
  if (problems.length) {
    throw new Error(`Arquivo de temporada inválido:\n- ${problems.slice(0, 20).join("\n- ")}`);
  }
}

/** Monta o arquivo de temporada a partir das partidas já convertidas. */
export function buildSeason(params: {
  season: number;
  competition: string;
  source: string;
  matches: Match[];
  ipoPositions: Record<string, number>;
  clubName: (id: string) => string;
}): SeasonFile {
  const ids = [...new Set(params.matches.flatMap((m) => [m.home, m.away]))];
  const clubs = ids
    .map((id) => {
      const ipoPosition = params.ipoPositions[id];
      if (ipoPosition === undefined) throw new Error(`Sem colocação de IPO para ${id}`);
      return { id, name: params.clubName(id), division: "A" as const, ipoPosition };
    })
    .sort((a, b) => a.ipoPosition - b.ipoPosition);
  const matches = markOutOfWindow(
    [...params.matches].sort((a, b) => kickoffTime(a) - kickoffTime(b) || a.id.localeCompare(b.id)),
  );
  const file: SeasonFile = {
    season: params.season,
    competition: params.competition,
    source: params.source,
    clubs,
    matches,
  };
  validateSeason(file);
  return file;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Marca como `postponed` os jogos disputados longe da janela da sua rodada
 * (mais de `toleranceDays` da mediana das datas da rodada): adiados ou
 * antecipados. Usado pelos conversores das fontes, que não trazem essa marca.
 */
export function markOutOfWindow(matches: Match[], toleranceDays = 3): Match[] {
  const byRound = new Map<number, number[]>();
  for (const m of matches) {
    if (m.round === undefined) continue;
    const list = byRound.get(m.round) ?? [];
    list.push(kickoffTime(m));
    byRound.set(m.round, list);
  }
  const median = new Map<number, number>();
  for (const [round, times] of byRound) {
    const sorted = [...times].sort((a, b) => a - b);
    median.set(round, sorted[Math.floor(sorted.length / 2)]!);
  }
  return matches.map((m) => {
    if (m.round === undefined) return m;
    const off = Math.abs(kickoffTime(m) - median.get(m.round)!) > toleranceDays * DAY_MS;
    const { postponed: _ignored, ...rest } = m;
    return off ? { ...rest, postponed: true } : rest;
  });
}
