/**
 * Baixa uma copa da API pública da ESPN (sem chave, sem documentação nem
 * termos publicados: serve para calibrar a simulação, não para o jogo) e
 * converte para o formato de partidas do FutBolsa.
 *
 * Uso:
 *   npm run data:fetch-espn-copa -- <copa-do-brasil|sul-americana> [ano] [saída]
 *
 * A API só aceita um dia por chamada, então são 365 chamadas (5 em paralelo).
 * Os horários vêm em UTC e são gravados no horário de Brasília. Clubes de fora
 * da Série A ganham um id próprio (ex.: "EXT-LANUS"): não têm ações, mas os
 * jogos deles decidem quando cada fase termina.
 */
import { writeFileSync } from "node:fs";
import { clubIdFromName } from "../src/data/clubs.js";
import type { Match } from "../src/engine/types.js";

const CUPS: Record<string, { league: string; phases: Record<string, string> }> = {
  "copa-do-brasil": {
    league: "bra.copa_do_brazil",
    phases: {
      "first-round": "1a-fase",
      "second-round": "2a-fase",
      "third-round": "3a-fase",
      "round-of-16": "oitavas",
      quarterfinals: "quartas",
      semifinals: "semifinal",
      finals: "final",
    },
  },
  "sul-americana": {
    league: "conmebol.sudamericana",
    phases: {
      "first-stage": "pre-1",
      "group-stage": "grupos",
      "knockout-round-playoffs": "playoffs",
      "round-of-16": "oitavas",
      quarterfinals: "quartas",
      semifinals: "semifinal",
      final: "final",
    },
  },
};

interface EspnCompetitor {
  homeAway: "home" | "away";
  score: string;
  winner?: boolean;
  team: { displayName: string };
}
interface EspnEvent {
  id: string;
  date: string;
  season: { slug: string };
  competitions: Array<{ status: { type: { name: string } }; competitors: EspnCompetitor[] }>;
}

const [competition, yearArg = "2025", outArg] = process.argv.slice(2);
const cup = competition ? CUPS[competition] : undefined;
if (!competition || !cup) {
  console.error(`Uso: npm run data:fetch-espn-copa -- <${Object.keys(CUPS).join("|")}> [ano] [saída]`);
  process.exit(1);
}
const year = Number(yearArg);
const output = outArg ?? `data/${competition}-${year}.json`;

const slug = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "");

function clubId(name: string): string {
  try {
    return clubIdFromName(name);
  } catch {
    return `EXT-${slug(name)}`;
  }
}

/** UTC da ESPN ("2025-12-21T21:00Z") para o horário de Brasília. */
function brasilia(utc: string): string {
  const t = new Date(Date.parse(utc) - 3 * 3600e3).toISOString().slice(0, 19);
  return `${t}-03:00`;
}

const days: string[] = [];
for (let t = Date.UTC(year, 0, 1); t <= Date.UTC(year, 11, 31); t += 86400e3) {
  days.push(new Date(t).toISOString().slice(0, 10).replaceAll("-", ""));
}
const events = new Map<string, EspnEvent>();
for (let i = 0; i < days.length; i += 5) {
  await Promise.all(
    days.slice(i, i + 5).map(async (d) => {
      const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${cup.league}/scoreboard?dates=${d}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`ESPN ${res.status} em ${d}`);
      const j = (await res.json()) as { events?: EspnEvent[] };
      for (const e of j.events ?? []) events.set(e.id, e);
    }),
  );
}

const matches: Match[] = [...events.values()]
  .sort((a, b) => a.date.localeCompare(b.date))
  .map((e) => {
    const phase = cup.phases[e.season.slug];
    if (!phase) throw new Error(`Fase desconhecida: "${e.season.slug}"`);
    const c = e.competitions[0]!;
    const status = c.status.type.name;
    const homeC = c.competitors.find((x) => x.homeAway === "home")!;
    const awayC = c.competitors.find((x) => x.homeAway === "away")!;
    const home = clubId(homeC.team.displayName);
    const away = clubId(awayC.team.displayName);
    const finished = /^STATUS_(FULL_TIME|FINAL)/.test(status);
    const match: Match = {
      id: `${year}-${competition}-${phase}-${e.date.slice(0, 10)}-${home}-${away}`,
      competition,
      phase,
      kickoff: brasilia(e.date),
      home,
      away,
      homeGoals: finished ? Number(homeC.score) : null,
      awayGoals: finished ? Number(awayC.score) : null,
      status: finished ? "finished" : status === "STATUS_CANCELED" ? "cancelled" : "scheduled",
    };
    // Pênaltis e final: vale quem a ESPN marca como vencedor.
    const winner = homeC.winner ? home : awayC.winner ? away : undefined;
    if (winner && (status === "STATUS_FINAL_PEN" || phase === "final")) match.winner = winner;
    return match;
  });

const out = {
  season: year,
  competition,
  source: `API pública da ESPN (${cup.league}), https://site.api.espn.com, baixado em ${new Date().toISOString().slice(0, 10)}`,
  matches,
};
writeFileSync(output, JSON.stringify(out, null, 2) + "\n");
const br = new Set(matches.flatMap((m) => [m.home, m.away]).filter((id) => !id.startsWith("EXT-")));
console.log(`${matches.length} jogos, ${br.size} clubes da Série A (${[...br].join(", ")}) → ${output}`);
