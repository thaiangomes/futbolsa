import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { ADMIN_ERROR_MESSAGES, type CompetitionCode, type ImportKind, type RunImportBody } from "@futbolsa/contracts";
import { Clock } from "../../../infra/clock/index.js";
import { DB, type Database, withTransaction } from "../../../infra/db/index.js";
import { matches } from "../../../infra/db/schema/index.js";
import { DomainError } from "../../../infra/http/index.js";
import { COMPETITIONS } from "../../../infra/db/schema/values.js";
import { currentSeason, type SeasonRow } from "../current-season.js";
import { AdminLogService } from "../log/index.js";
import { StandingsService } from "../standings/standings.service.js";
import { ImportService, type ImportReport } from "./import.service.js";
import { ResultSourceRegistry } from "./sources/registry.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** O calendário é importado uma vez por dia: passou disto desde a última importação, roda. */
const CALENDAR_MAX_AGE = DAY;
/** Placar devido há muito tempo não varre dias demais da fonte: no máximo estes dias para trás. */
const SCORES_LOOKBACK = 14 * DAY;
/**
 * O jogo fora da janela da rodada (adiado e jogado semanas depois, `out_of_window`) não conta para fechar a rodada, mas o placar
 * dele entra como o de qualquer outro: fica "devido" por este tempo depois do início. Passado isso, o adiado que a fonte nunca
 * trouxe como jogado (data velha, sem remarcação) deixa de puxar a fonte a cada 15 minutos, e o calendário diário o corrige.
 */
const OUT_OF_WINDOW_DUE_FOR = 2 * DAY;
/** "Importar na hora" dos placares olha os últimos dias. */
const MANUAL_SCORES_WINDOW = 3 * DAY;

const isStandingsCompetition = (c: CompetitionCode): c is "brasileirao-a" | "brasileirao-b" =>
  c === "brasileirao-a" || c === "brasileirao-b";

/**
 * O que as tarefas agendadas fazem, calculado pelo que já devia ter acontecido: uma tarefa que perdeu o horário
 * (a API estava fora) se recupera sozinha na próxima rodada (Arquitetura da Fase 1, Tarefas agendadas).
 * Cada tarefa roda uma por vez (a API é uma instância só nesta fase). A falha da fonte vira registro no log da
 * API e relatório com o erro; a próxima rodada tenta de novo e nada é apagado.
 */
@Injectable()
export class ImportRunner {
  private readonly logger = new Logger("Resultados");
  private readonly running = new Set<string>();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly clock: Clock,
    private readonly imports: ImportService,
    private readonly standings: StandingsService,
    private readonly sources: ResultSourceRegistry,
    private readonly log: AdminLogService,
  ) {}

  /** Calendário: roda nas competições cuja última importação tem mais de 24 horas (ou nunca houve). */
  runCalendarIfStale(): Promise<ImportReport[]> {
    return this.exclusive("calendar", async (season) => {
      const last = await this.lastImports(season.id);
      const now = this.clock.now().getTime();
      const reports: ImportReport[] = [];
      for (const competition of COMPETITIONS) {
        const at = last.get(competition);
        if (at !== undefined && now - at <= CALENDAR_MAX_AGE) continue;
        reports.push(await this.importCalendar(season, competition));
      }
      return reports;
    });
  }

  /** Placares: só das competições com jogo devido (fim previsto passado, sem placar); depois, a classificação. */
  runScores(): Promise<ImportReport[]> {
    return this.exclusive("scores", async (season) => {
      const now = this.clock.now();
      const due = await this.dueMatches(season.id, now);
      const reports: ImportReport[] = [];
      for (const [competition, earliest] of due) {
        const from = new Date(Math.max(earliest.getTime(), now.getTime() - SCORES_LOOKBACK));
        const report = await this.importScores(season, competition, { from, to: now });
        reports.push(report);
        if (report.error === null && isStandingsCompetition(competition)) {
          reports.push(await this.importStandings(season, competition));
        }
      }
      return reports;
    });
  }

  /**
   * `POST /admin/imports/run`: importa na hora, sem esperar os 15 minutos. Devolve o erro da fonte em vez de lançar.
   * Diferente das importações agendadas, é uma ação do admin: vai para o registro (Admin, critério 33) com o pedido
   * e o resumo de cada etapa, depois de importar (cada etapa grava na transação dela).
   */
  async runNow(actorId: string, body: RunImportBody): Promise<ImportReport[]> {
    const season = await currentSeason(this.db);
    const reports = season ? await this.runNowIn(season, body) : [];
    await withTransaction(this.db, (tx) =>
      this.log.record(tx, {
        actorId,
        action: "import.run",
        ...(season ? { targetType: "season", targetId: String(season.id) } : {}),
        after: {
          request: { competition: body.competition ?? null, kind: body.kind ?? null },
          reports: reports.map((r) => ({
            competition: r.competition,
            kind: r.kind,
            inserted: r.inserted,
            updated: r.updated,
            unchanged: r.unchanged,
            clubsCreated: r.clubsCreated,
            error: r.error?.code ?? null,
          })),
        },
      }),
    );
    return reports;
  }

  private async runNowIn(season: SeasonRow, body: RunImportBody): Promise<ImportReport[]> {
    const competitions = body.competition ? [body.competition] : COMPETITIONS;
    const now = this.clock.now();
    const reports: ImportReport[] = [];
    for (const competition of competitions) {
      const kinds: ImportKind[] = body.kind ? [body.kind] : isStandingsCompetition(competition) ? ["calendar", "standings"] : ["calendar"];
      for (const kind of kinds) {
        if (kind === "calendar") reports.push(await this.importCalendar(season, competition));
        else if (kind === "scores") {
          reports.push(await this.importScores(season, competition, { from: new Date(now.getTime() - MANUAL_SCORES_WINDOW), to: now }));
        } else if (isStandingsCompetition(competition)) reports.push(await this.importStandings(season, competition));
      }
    }
    return reports;
  }

  private async exclusive(name: string, fn: (season: SeasonRow) => Promise<ImportReport[]>): Promise<ImportReport[]> {
    if (this.running.has(name)) return [];
    this.running.add(name);
    try {
      const season = await currentSeason(this.db);
      return season ? await fn(season) : [];
    } finally {
      this.running.delete(name);
    }
  }

  private async importCalendar(season: SeasonRow, competition: CompetitionCode): Promise<ImportReport> {
    return this.guard(competition, "calendar", () =>
      this.imports.importFromSource(this.sources.forCompetition(competition), season.id, competition, season.year),
    );
  }

  private async importScores(season: SeasonRow, competition: CompetitionCode, range: { from: Date; to: Date }): Promise<ImportReport> {
    return this.guard(competition, "scores", () =>
      this.imports.importFromSource(this.sources.forCompetition(competition), season.id, competition, season.year, { range, kind: "scores" }),
    );
  }

  private async importStandings(season: SeasonRow, competition: "brasileirao-a" | "brasileirao-b"): Promise<ImportReport> {
    return this.guard(competition, "standings", () =>
      this.standings.importFromSource(this.sources.forCompetition(competition), season.id, competition, season.year),
    );
  }

  private async guard(competition: CompetitionCode, kind: ImportKind, run: () => Promise<ImportReport>): Promise<ImportReport> {
    try {
      return await run();
    } catch (error) {
      // O detalhe (resposta da fonte, endereço, SQL) fica só no log do servidor; o relatório leva código e
      // mensagem genérica, como as respostas de erro da API. Recusa nossa (DomainError) já tem mensagem pública.
      this.logger.error(`${kind} de ${competition} falhou: ${(error as Error).message}`, (error as Error).stack);
      const reported =
        error instanceof DomainError
          ? { code: error.code, message: error.message }
          : { code: "import_failed", message: ADMIN_ERROR_MESSAGES.import_failed };
      return { competition, kind, inserted: 0, updated: 0, unchanged: 0, clubsCreated: [], error: reported };
    }
  }

  /** A última importação de cada competição: o maior `fetchedAt` dos jogos dela. */
  private async lastImports(seasonId: number): Promise<Map<string, number>> {
    const rows = await this.db
      .select({
        competition: matches.competition,
        at: sql<string | null>`max((${matches.sourceSnapshot}->>'fetchedAt')::timestamptz)`,
      })
      .from(matches)
      .where(eq(matches.seasonId, seasonId))
      .groupBy(matches.competition);
    return new Map(rows.filter((r) => r.at).map((r) => [r.competition, new Date(r.at!).getTime()]));
  }

  /** Por competição, o início do jogo devido mais antigo. */
  private async dueMatches(seasonId: number, now: Date): Promise<Map<CompetitionCode, Date>> {
    const rows = await this.db
      .select({ competition: matches.competition, earliest: sql<string>`min(${matches.kickoff})` })
      .from(matches)
      .where(
        and(
          eq(matches.seasonId, seasonId),
          eq(matches.status, "scheduled"),
          isNull(matches.homeGoals),
          // o jogo fora da janela só entra na lista enquanto o fim dele é recente (Chapecoense x Vasco, item 24 das melhorias)
          or(eq(matches.outOfWindow, false), sql`${matches.kickoff} >= ${new Date(now.getTime() - OUT_OF_WINDOW_DUE_FOR).toISOString()}::timestamptz`),
          sql`coalesce(${matches.finishedAt}, ${matches.kickoff} + interval '2 hours') <= ${now.toISOString()}::timestamptz`,
        ),
      )
      .groupBy(matches.competition);
    return new Map(rows.map((r) => [r.competition as CompetitionCode, new Date(r.earliest)]));
  }
}
