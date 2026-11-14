import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CompetitionCode } from "@futbolsa/contracts";
import { clubName, computeStandings, finishTime, kickoffTime, type Match } from "@futbolsa/engine";
import type { DateRange, ResultSource, SourceMatch, SourceStanding } from "../src/modules/admin/results/sources/types.js";

/**
 * Fonte de resultados de reprodução (P3 do Plano do ensaio): lê os jogos de 2025 de `packages/engine/data/*.json` e só
 * "revela" o placar de um jogo depois do fim previsto, segundo o relógio simulado. Antes disso o jogo é `scheduled` e
 * sem placar. A classificação oficial sai de `computeStandings` dos jogos revelados. A API nunca chama a football-data.org
 * nem a ESPN no ensaio.
 */

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/engine/data");

/** Arquivo de cada competição (o motor chama a Sul-Americana de `sul-americana`, a API de `sulamericana`). */
const FILES: Record<CompetitionCode, string | null> = {
  "brasileirao-a": "brasileirao-2025.json",
  // não há arquivo da Série B de 2025 no repositório: `serieBSintetica` põe dois times de fora e duas rodadas, só para a
  // competição existir e fechar (sem ela a recompra espera para sempre, porque `closes["brasileirao-b"]` fica indefinido)
  "brasileirao-b": null,
  "copa-do-brasil": "copa-do-brasil-2025.json",
  libertadores: "libertadores-2025.json",
  sulamericana: "sul-americana-2025.json",
};

/** A Série B mínima do ensaio: dois times de fora do jogo, ida e volta em abril de 2025, já encerradas. */
export function serieBSintetica(): Match[] {
  const base = { competition: "brasileirao-b", status: "finished" as const };
  return [
    { ...base, id: "2025-brasileirao-b-1", round: 1, kickoff: "2025-04-05T16:00:00-03:00", home: "EXT-SERIE-B-ALFA", away: "EXT-SERIE-B-BETA", homeGoals: 1, awayGoals: 0 },
    { ...base, id: "2025-brasileirao-b-2", round: 2, kickoff: "2025-04-12T16:00:00-03:00", home: "EXT-SERIE-B-BETA", away: "EXT-SERIE-B-ALFA", homeGoals: 0, awayGoals: 0 },
  ];
}

/** A final sintética de uma copa na temporada curta: dois times de fora, uma partida, para a competição existir e fechar. */
export function finalSintetica(competicao: string): Match[] {
  return [{ id: `2025-${competicao}-final-sintetica`, competition: competicao, phase: "final", kickoff: "2025-04-09T16:00:00-03:00", home: `EXT-${competicao.toUpperCase()}-ALFA`, away: `EXT-${competicao.toUpperCase()}-BETA`, homeGoals: 2, awayGoals: 1, status: "finished", winner: `EXT-${competicao.toUpperCase()}-ALFA` }];
}

export interface Substituicao {
  /** Troca o jogo no calendário e nos placares (percalços: placar corrigido pela fonte, jogo adiado). */
  matchId: string;
  /** O placar que a fonte passa a trazer a partir do instante dado. */
  placar?: { homeGoals: number; awayGoals: number };
  /** O novo início do jogo (adiado). */
  kickoff?: string;
  status?: "postponed" | "cancelled";
}

export class ReplaySource implements ResultSource {
  readonly id = "replay";
  /** Percalços vistos pela fonte a partir de um instante simulado. */
  private readonly overrides: Array<Substituicao & { from: number }> = [];
  private readonly cache = new Map<CompetitionCode, Match[]>();
  /** Quantas chamadas cada método recebeu, para o teste. */
  readonly calls = { matches: 0, standings: 0 };
  /** Faz a fonte falhar nas próximas chamadas (a fonte fora do ar). */
  failNext = 0;

  constructor(
    private readonly now: () => Date,
    /** Temporada curta (ensaio rápido): só as primeiras rodadas do Brasileirão e nenhuma copa. */
    private readonly curta?: { rodadas: number },
  ) {}

  /** O arquivo da competição: todos os jogos, na ordem do arquivo. */
  matchesOf(competition: CompetitionCode): Match[] {
    let list = this.cache.get(competition);
    if (!list) {
      const file = FILES[competition];
      list = file ? (JSON.parse(readFileSync(join(DATA_DIR, file), "utf8")) as { matches: Match[] }).matches : competition === "brasileirao-b" ? serieBSintetica() : [];
      if (this.curta) list = competition === "brasileirao-a" ? list.filter((m) => (m.round ?? 0) <= this.curta!.rodadas) : competition === "brasileirao-b" ? list : finalSintetica(competition);
      this.cache.set(competition, list);
    }
    return list;
  }

  /** Percalço: a partir de `from`, a fonte passa a trazer a substituição. */
  substituir(from: Date, s: Substituicao): void {
    this.overrides.push({ ...s, from: from.getTime() });
  }

  /** O jogo como a fonte o vê agora. */
  private view(m: Match): Match {
    const now = this.now().getTime();
    let seen = m;
    for (const o of this.overrides) {
      if (o.matchId !== m.id || o.from > now) continue;
      seen = {
        ...seen,
        ...(o.kickoff ? { kickoff: o.kickoff, finishedAt: undefined } : {}),
        ...(o.placar ? { homeGoals: o.placar.homeGoals, awayGoals: o.placar.awayGoals, status: "finished" as const } : {}),
      };
    }
    return seen;
  }

  /** Os jogos revelados até agora: o placar só aparece depois do fim previsto. */
  revealed(competition: CompetitionCode): Match[] {
    const now = this.now().getTime();
    return this.matchesOf(competition)
      .map((m) => this.view(m))
      .filter((m) => m.status === "finished" && finishTime(m) <= now);
  }

  async fetchMatches(competition: CompetitionCode, _year: number, range?: DateRange): Promise<SourceMatch[]> {
    this.calls.matches++;
    this.maybeFail();
    const now = this.now().getTime();
    const out: SourceMatch[] = [];
    for (const raw of this.matchesOf(competition)) {
      const m = this.view(raw);
      const at = kickoffTime(m);
      if (range && (at < range.from.getTime() || at > range.to.getTime())) continue;
      const override = this.overrides.find((o) => o.matchId === m.id && o.from <= now && o.status);
      const done = m.status === "finished" && finishTime(m) <= now;
      const status = override?.status ?? (m.status === "cancelled" ? "cancelled" : done ? "finished" : "scheduled");
      out.push({
        source: this.id,
        sourceId: m.id,
        competition,
        round: m.round ?? null,
        phase: m.phase ?? null,
        kickoff: new Date(at),
        status,
        homeName: clubName(m.home),
        awayName: clubName(m.away),
        homeGoals: status === "finished" ? m.homeGoals : null,
        awayGoals: status === "finished" ? m.awayGoals : null,
        advancedName: status === "finished" && m.winner ? clubName(m.winner) : null,
      });
    }
    return out;
  }

  async fetchStandings(competition: CompetitionCode): Promise<SourceStanding[]> {
    this.calls.standings++;
    this.maybeFail();
    if (competition !== "brasileirao-a" && competition !== "brasileirao-b") return [];
    return computeStandings(this.revealed(competition)).map((r, i) => ({ clubName: clubName(r.clubId), position: i + 1, points: r.points }));
  }

  private maybeFail(): void {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("fonte de reprodução fora do ar (de propósito)");
    }
  }
}
