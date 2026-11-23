import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CompetitionCode } from "@futbolsa/contracts";
import { clubName, computeStandings, finishTime, gameMinute, kickoffTime, type LiveMatch, type Match } from "@futbolsa/engine";
import type { DateRange, ResultSource, SourceMatch, SourceStanding } from "../src/modules/admin/results/sources/types.js";

/**
 * Fonte de resultados de reprodução (P3 do Plano do ensaio): lê os jogos de 2025 de `packages/engine/data/*.json` e só
 * "revela" o placar de um jogo depois do fim previsto, segundo o relógio simulado. Antes disso o jogo é `scheduled` e
 * sem placar. A classificação oficial sai de `computeStandings` dos jogos revelados. A API nunca chama a football-data.org
 * nem a ESPN no ensaio.
 */

export const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/engine/data");

/** Arquivo de cada competição por ano (o motor chama a Sul-Americana de `sul-americana`, a API de `sulamericana`). */
const ARQUIVOS: Record<number, Record<CompetitionCode, string | null>> = {
  2025: {
    "brasileirao-a": "brasileirao-2025.json",
    // não há arquivo da Série B de 2025 no repositório: `serieBSintetica` põe dois times de fora e duas rodadas, só para a
    // competição existir e fechar (sem ela a recompra espera para sempre, porque `closes["brasileirao-b"]` fica indefinido)
    "brasileirao-b": null,
    "copa-do-brasil": "copa-do-brasil-2025.json",
    libertadores: "libertadores-2025.json",
    sulamericana: "sul-americana-2025.json",
  },
  // 2026 (partida de teste): tudo real, inclusive a Série B, sem competições sintéticas
  2026: {
    "brasileirao-a": "brasileirao-2026.json",
    "brasileirao-b": "brasileirao-b-2026.json",
    "copa-do-brasil": "copa-do-brasil-2026.json",
    libertadores: "libertadores-2026.json",
    sulamericana: "sul-americana-2026.json",
  },
};

/** Os jogos de cada competição quando não vêm dos arquivos do repositório (a partida os lê do banco, `partida_dados`). */
export type DadosEmMemoria = Partial<Record<CompetitionCode, Match[]>>;

const TODAS: CompetitionCode[] = ["brasileirao-a", "brasileirao-b", "copa-do-brasil", "libertadores", "sulamericana"];

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
    /** Ano dos arquivos (padrão 2025) e, se houver, os jogos já carregados em memória no lugar dos arquivos. */
    origem: { ano?: number; dados?: DadosEmMemoria } = {},
  ) {
    this.ano = origem.ano ?? 2025;
    this.dados = origem.dados;
  }

  private readonly ano: number;
  private dados: DadosEmMemoria | undefined;

  /** A partida baixou dados novos: troca a foto dos jogos (os percalços e os contadores ficam). */
  trocarDados(dados: DadosEmMemoria): void {
    this.dados = dados;
    this.cache.clear();
  }

  /**
   * O limite do relógio da partida: o fim do último jogo terminado nos dados (o tempo não passa daqui: depois dele não há
   * resultado real para mostrar). `null` se nenhum jogo terminou.
   */
  limite(): number | null {
    let ultimo: number | null = null;
    for (const c of TODAS) {
      for (const m of this.matchesOf(c)) {
        if (m.status !== "finished") continue;
        const fim = finishTime(m);
        if (ultimo === null || fim > ultimo) ultimo = fim;
      }
    }
    return ultimo;
  }

  /**
   * Os jogos do Brasileirão e das copas em andamento agora, com o placar parcial que a última baixa trouxe (item 23). Só os bots da
   * partida usam isto; quem decide se o dado ainda vale (baixado há pouco, relógio na hora real) é a partida.
   */
  parciais(): LiveMatch[] {
    const now = this.now().getTime();
    const out: LiveMatch[] = [];
    for (const c of ["brasileirao-a", "brasileirao-b", "copa-do-brasil", "libertadores", "sulamericana"] as const) {
      for (const m of this.matchesOf(c)) {
        if (!m.parcial || m.status === "finished") continue;
        const inicio = kickoffTime(m);
        if (now < inicio || now > inicio + 3 * 3_600_000) continue;
        out.push({ home: m.home, away: m.away, homeGoals: m.parcial.homeGoals, awayGoals: m.parcial.awayGoals, minute: gameMinute(now - inicio) });
      }
    }
    return out;
  }

  /** O arquivo da competição: todos os jogos, na ordem do arquivo. */
  matchesOf(competition: CompetitionCode): Match[] {
    let list = this.cache.get(competition);
    if (!list) {
      const file = ARQUIVOS[this.ano]?.[competition];
      if (this.dados) list = this.dados[competition] ?? [];
      else if (!ARQUIVOS[this.ano]) throw new Error(`sem arquivos de dados para ${this.ano}`);
      else list = file ? (JSON.parse(readFileSync(join(DATA_DIR, file), "utf8")) as { matches: Match[] }).matches : competition === "brasileirao-b" ? serieBSintetica() : [];
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
