/**
 * Converte um arquivo do openfootball/football.json (domínio público, CC0) para
 * o formato de temporada do FutBolsa.
 *
 * Uso:
 *   npm run data:convert -- <entrada br.1.json> [saída] [ano]
 *
 * Fonte: https://github.com/openfootball/football.json (ex.: 2025/br.1.json).
 * Os horários do arquivo são de Brasília (UTC−3).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { clubIdFromName, clubName, IPO_POSITIONS_2025 } from "../src/data/clubs.js";
import { buildSeason } from "../src/data/season.js";
import type { Match } from "../src/engine/types.js";

interface OpenfootballMatch {
  round: string;
  date: string;
  time?: string;
  team1: string;
  team2: string;
  score?: [number, number] | { ft?: [number, number] };
}

const [input, output = "data/brasileirao-2025.json", yearArg = "2025"] = process.argv.slice(2);
if (!input) {
  console.error("Uso: npm run data:convert -- <br.1.json> [saída] [ano]");
  process.exit(1);
}

const raw = JSON.parse(readFileSync(input, "utf8")) as {
  matches: OpenfootballMatch[];
};

const matches: Match[] = raw.matches.map((m) => {
  const round = Number(/\d+/.exec(m.round)?.[0]);
  const ft = Array.isArray(m.score) ? m.score : m.score?.ft;
  const home = clubIdFromName(m.team1);
  const away = clubIdFromName(m.team2);
  return {
    id: `${yearArg}-r${String(round).padStart(2, "0")}-${home}-${away}`,
    competition: "brasileirao-a",
    round,
    kickoff: `${m.date}T${m.time ?? "16:00"}:00-03:00`,
    home,
    away,
    homeGoals: ft ? ft[0] : null,
    awayGoals: ft ? ft[1] : null,
    status: ft ? "finished" : "scheduled",
  };
});

const season = buildSeason({
  season: Number(yearArg),
  competition: "brasileirao-a",
  source: "openfootball/football.json (CC0), https://github.com/openfootball/football.json",
  matches,
  ipoPositions: IPO_POSITIONS_2025,
  clubName,
});

writeFileSync(output, JSON.stringify(season, null, 2) + "\n");
const postponed = season.matches.filter((m) => m.postponed).length;
console.log(`${season.matches.length} jogos, ${season.clubs.length} clubes, ${postponed} fora da janela da rodada → ${output}`);
