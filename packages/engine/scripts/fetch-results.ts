/**
 * Baixa os jogos do Brasileirão Série A na API football-data.org (plano
 * gratuito inclui a Série A, código BSA) e grava no formato de temporada.
 *
 * Uso:
 *   FOOTBALL_DATA_KEY=sua-chave npm run data:fetch -- [ano] [saída]
 *
 * A chave vem só da variável de ambiente FOOTBALL_DATA_KEY e nunca deve ser
 * commitada (veja .env.example). Plano gratuito: 10 requisições por minuto;
 * este script faz uma só.
 */
import { writeFileSync } from "node:fs";
import { clubIdFromName, clubName, IPO_POSITIONS_2025 } from "../src/data/clubs.js";
import { buildSeason } from "../src/data/season.js";
import type { Match, MatchStatus } from "../src/engine/types.js";

interface FdMatch {
  id: number;
  utcDate: string;
  status: string;
  matchday: number | null;
  homeTeam: { name: string };
  awayTeam: { name: string };
  score: { fullTime: { home: number | null; away: number | null } };
}

const [yearArg = "2025", output = `data/brasileirao-${yearArg}.json`] = process.argv.slice(2);
const key = process.env.FOOTBALL_DATA_KEY;
if (!key) {
  console.error("Defina FOOTBALL_DATA_KEY (chave gratuita em https://www.football-data.org/client/register).");
  process.exit(1);
}

const url = `https://api.football-data.org/v4/competitions/BSA/matches?season=${yearArg}`;
const response = await fetch(url, { headers: { "X-Auth-Token": key } });
if (!response.ok) {
  console.error(`football-data.org respondeu ${response.status}: ${await response.text()}`);
  process.exit(1);
}
const body = (await response.json()) as { matches: FdMatch[] };

const statusOf = (s: string): MatchStatus =>
  s === "FINISHED" || s === "AWARDED" ? "finished" : s === "CANCELLED" ? "cancelled" : "scheduled";

const matches: Match[] = body.matches.map((m) => {
  const status = statusOf(m.status);
  const finished = status === "finished";
  return {
    id: `fd-${m.id}`,
    competition: "brasileirao-a",
    round: m.matchday ?? undefined,
    kickoff: m.utcDate,
    home: clubIdFromName(m.homeTeam.name),
    away: clubIdFromName(m.awayTeam.name),
    homeGoals: finished ? m.score.fullTime.home : null,
    awayGoals: finished ? m.score.fullTime.away : null,
    status,
  };
});

if (yearArg !== "2025") {
  console.warn("Atenção: as colocações de IPO em src/data/clubs.ts são as de 2025; ajuste para outro ano.");
}

const season = buildSeason({
  season: Number(yearArg),
  competition: "brasileirao-a",
  source: `football-data.org (${url})`,
  matches,
  ipoPositions: IPO_POSITIONS_2025,
  clubName,
});

writeFileSync(output, JSON.stringify(season, null, 2) + "\n");
console.log(`${season.matches.length} jogos gravados em ${output}`);
