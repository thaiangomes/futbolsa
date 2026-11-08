import { type CompetitionCode, competitionSchema } from "@futbolsa/contracts";
import { EspnSource } from "./espn.js";
import { FootballDataSource } from "./football-data.js";
import type { ResultSource } from "./types.js";

/**
 * Qual fonte atende cada competição (`RESULT_SOURCES`). A football-data.org só vale onde o plano em uso
 * a cobre; a ESPN atende as demais (Fontes de dados, decisão do Thaian em 2026-10-30). Quem pagar um plano
 * maior muda a configuração, não o código.
 */
export class ResultSourceRegistry {
  constructor(private readonly pick: (competition: CompetitionCode) => ResultSource) {}

  forCompetition(competition: CompetitionCode): ResultSource {
    return this.pick(competition);
  }
}

/**
 * Lê `RESULT_SOURCES`, no formato `brasileirao-a=football-data,libertadores=football-data`. O que não for
 * citado usa a ESPN, a padrão: em 2026-11-08 a chave da football-data.org não alcançava nem a Série A.
 */
export function parseResultSources(env: NodeJS.ProcessEnv = process.env, fetchFn?: typeof fetch): ResultSourceRegistry {
  const espn = new EspnSource({ fetchFn });
  const chosen = new Map<CompetitionCode, ResultSource>();
  const entries = (env.RESULT_SOURCES ?? "").split(",").map((e) => e.trim()).filter(Boolean);
  let footballData: FootballDataSource | undefined;
  for (const entry of entries) {
    const [name, sourceName] = entry.split("=").map((p) => p.trim());
    const competition = competitionSchema.safeParse(name);
    if (!competition.success) throw new Error(`RESULT_SOURCES: competição desconhecida "${name}".`);
    if (sourceName === "espn") chosen.set(competition.data, espn);
    else if (sourceName === "football-data") {
      if (!env.FOOTBALL_DATA_KEY) throw new Error("RESULT_SOURCES pede a football-data.org, mas falta FOOTBALL_DATA_KEY.");
      footballData ??= new FootballDataSource({ key: env.FOOTBALL_DATA_KEY, fetchFn });
      chosen.set(competition.data, footballData);
    } else {
      throw new Error(`RESULT_SOURCES: fonte desconhecida "${sourceName}" (use espn ou football-data).`);
    }
  }
  return new ResultSourceRegistry((competition) => chosen.get(competition) ?? espn);
}
