import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { and, desc, eq, inArray, lt, sql, type SQL } from "drizzle-orm";
import { COMMON_ERROR_MESSAGES, type FraudCaseItem, type FraudCasesQuery, type FraudCasesResponse } from "@futbolsa/contracts";
import { DB, type Database } from "../../../infra/db/index.js";
import { clubs, fraudCases, fraudCaseTrades } from "../../../infra/db/schema/index.js";
import { DomainError } from "../../../infra/http/index.js";
import { currentSeason } from "../current-season.js";
import { AdminEvents } from "../events.js";
import { fraudParties } from "./parties.js";

const PAGE = 50;

/**
 * Os casos de trapaça da temporada atual (T21): a lista da tela do admin e o número de casos abertos que entra nas
 * pendências e na visão geral. O relatório de um caso é outro serviço (T22).
 */
@Injectable()
export class FraudCasesService implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly events: AdminEvents,
  ) {}

  onModuleInit(): void {
    this.events.registerFraudCounter(() => this.openCount());
  }

  /** Casos abertos da temporada atual. */
  async openCount(): Promise<number> {
    const season = await currentSeason(this.db);
    if (!season) return 0;
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(fraudCases)
      .where(and(eq(fraudCases.seasonId, season.id), eq(fraudCases.status, "open")));
    return row?.n ?? 0;
  }

  /** Do mais novo para o mais antigo, em páginas por id. */
  async list(query: FraudCasesQuery): Promise<FraudCasesResponse> {
    const season = await currentSeason(this.db);
    if (!season) return { cases: [], nextCursor: null };
    const filters: SQL[] = [eq(fraudCases.seasonId, season.id)];
    if (query.status) filters.push(eq(fraudCases.status, query.status));
    if (query.cursor) {
      const after = Number(query.cursor);
      if (!Number.isSafeInteger(after) || after < 1) throw new DomainError("invalid_input", 400, COMMON_ERROR_MESSAGES.invalid_input, ["cursor"]);
      filters.push(lt(fraudCases.id, after));
    }
    const rows = await this.db
      .select({ c: fraudCases, ticker: clubs.ticker })
      .from(fraudCases)
      .leftJoin(clubs, eq(clubs.id, fraudCases.clubId))
      .where(and(...filters))
      .orderBy(desc(fraudCases.id))
      .limit(PAGE + 1);
    const page = rows.slice(0, PAGE);
    if (page.length === 0) return { cases: [], nextCursor: null };

    const counts = await this.db
      .select({
        caseId: fraudCaseTrades.caseId,
        total: sql<number>`count(*)::int`,
        suspicious: sql<number>`count(*) filter (where ${fraudCaseTrades.suspicious})::int`,
      })
      .from(fraudCaseTrades)
      .where(inArray(fraudCaseTrades.caseId, page.map((r) => r.c.id)))
      .groupBy(fraudCaseTrades.caseId);
    const byCase = new Map(counts.map((c) => [c.caseId, c]));
    const parties = await fraudParties(this.db, season.id, [...new Set(page.flatMap((r) => [r.c.walletLow, r.c.walletHigh]))]);

    const cases: FraudCaseItem[] = page.map((r) => ({
      id: r.c.id,
      origin: r.c.origin as FraudCaseItem["origin"],
      status: r.c.status as FraudCaseItem["status"],
      ticker: r.ticker,
      periodFrom: r.c.periodFrom.toISOString(),
      periodTo: r.c.periodTo.toISOString(),
      openedAt: r.c.openedAt.toISOString(),
      decidedAt: r.c.decidedAt?.toISOString() ?? null,
      parties: [parties.get(r.c.walletLow)!, parties.get(r.c.walletHigh)!],
      tradeCount: byCase.get(r.c.id)?.total ?? 0,
      suspiciousCount: byCase.get(r.c.id)?.suspicious ?? 0,
    }));
    return { cases, nextCursor: rows.length > PAGE ? String(page[page.length - 1]!.c.id) : null };
  }
}
