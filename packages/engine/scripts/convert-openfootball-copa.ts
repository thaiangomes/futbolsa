/**
 * Converte uma copa do openfootball/football.json (domínio público, CC0) para
 * o formato de partidas do FutBolsa. Hoje só a Libertadores (2025/copa.l.json).
 *
 * Uso:
 *   npm run data:convert-copa -- <entrada copa.l.json> [saída] [ano]
 *
 * Clubes de fora da Série A ganham um id próprio (ex.: "EXT-RIVER-PLATE-ARG"):
 * não têm ações, mas os jogos deles decidem quando cada fase termina. Os
 * horários vêm como no arquivo, tratados como de Brasília (UTC−3); nos jogos
 * fora do Brasil podem estar no horário local.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { clubIdFromName } from "../src/data/clubs.js";
import type { Match } from "../src/engine/types.js";

interface OpenfootballMatch {
  round: string;
  date: string;
  time?: string;
  team1: string;
  team2: string;
  status?: string;
  score?: [number, number] | { ft?: [number, number]; p?: [number, number] };
}

const PHASES: Array<[RegExp, string]> = [
  [/^Qualifying, Round (\d)$/, "pre-$1"],
  [/^Group/, "grupos"],
  [/Round of 16$/, "oitavas"],
  [/Quarterfinals$/, "quartas"],
  [/Semifinals$/, "semifinal"],
  [/Final$/, "final"],
];

const [input, output = "data/libertadores-2025.json", yearArg = "2025"] = process.argv.slice(2);
if (!input) {
  console.error("Uso: npm run data:convert-copa -- <copa.l.json> [saída] [ano]");
  process.exit(1);
}

const slug = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "");

function clubId(team: string): string {
  const m = /^(.*) \(([A-Z]{3})\)$/.exec(team);
  const [name, country] = m ? [m[1]!, m[2]!] : [team, ""];
  if (country === "BRA") return clubIdFromName(name);
  return `EXT-${slug(name)}-${country}`;
}

function phaseOf(round: string): string {
  for (const [re, name] of PHASES) if (re.test(round)) return name.includes("$1") ? round.replace(re, name) : name;
  throw new Error(`Fase desconhecida: "${round}"`);
}

const raw = JSON.parse(readFileSync(input, "utf8")) as { name: string; matches: OpenfootballMatch[] };

const matches: Match[] = raw.matches.map((m) => {
  const phase = phaseOf(m.round);
  const ft = Array.isArray(m.score) ? m.score : m.score?.ft;
  const pens = Array.isArray(m.score) ? undefined : m.score?.p;
  const home = clubId(m.team1);
  const away = clubId(m.team2);
  // Jogo interrompido e sem placar no arquivo (Colo-Colo × Fortaleza, 2025): não conta para nada.
  const status = ft ? "finished" : m.status === "postponed" ? "cancelled" : "scheduled";
  const match: Match = {
    id: `${yearArg}-lib-${phase}-${m.date}-${home}-${away}`,
    competition: "libertadores",
    phase,
    kickoff: `${m.date}T${m.time ?? "21:30"}:00-03:00`,
    home,
    away,
    homeGoals: ft ? ft[0] : null,
    awayGoals: ft ? ft[1] : null,
    status,
  };
  if (pens) match.winner = pens[0] > pens[1] ? home : away;
  return match;
});

const out = {
  season: Number(yearArg),
  competition: "libertadores",
  source: `openfootball/football.json (CC0), ${raw.name}, https://github.com/openfootball/football.json`,
  matches,
};
writeFileSync(output, JSON.stringify(out, null, 2) + "\n");
const br = new Set(matches.flatMap((m) => [m.home, m.away]).filter((id) => !id.startsWith("EXT-")));
console.log(`${matches.length} jogos, ${br.size} clubes da Série A (${[...br].join(", ")}) → ${output}`);
