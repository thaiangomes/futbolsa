import { Controller, Get, Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Overview } from "@futbolsa/contracts";
import { AdminOnly } from "../../infra/auth-adapter/index.js";
import { Clock } from "../../infra/clock/index.js";
import { DB, type Database } from "../../infra/db/index.js";
import { seasonCups } from "../../infra/db/schema/index.js";
import { CUP_COMPETITIONS } from "../../infra/db/schema/values.js";
import { IpoOpeningService, IpoSettlementService } from "../ipo/index.js";
import { currentSeason } from "./current-season.js";
import { PayoutsStatusService } from "./payouts/outstanding.js";
import { PendingService } from "./results/pending.service.js";
import { StandingsService } from "./standings/standings.service.js";
import { SuspensionService } from "./suspension/suspension.service.js";

/** O que pede atenção do admin, juntando o que as outras partes já calculam (tela inicial do admin). */
@Injectable()
export class OverviewService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly pending: PendingService,
    private readonly standings: StandingsService,
    private readonly suspension: SuspensionService,
    private readonly ipoOpening: IpoOpeningService,
    private readonly ipoSettlement: IpoSettlementService,
    private readonly clock: Clock,
    private readonly payouts: PayoutsStatusService,
  ) {}

  async compute(): Promise<Overview> {
    const season = await currentSeason(this.db);
    const [pending, tables, suspension, ipoBlockers] = await Promise.all([
      this.pending.compute(),
      this.standings.list(),
      this.suspension.state(),
      // "O IPO não abriu: falta …" (proposta 6 do Plano do IPO), só depois do horário de abertura.
      this.ipoOpening.blockers(this.clock.now()),
    ]);
    const outstanding = season ? await this.payouts.outstanding(season.id, this.clock.now()) : { pending: 0, settling: 0, correctionEvents: 0 };
    const confirmedCups = new Set(
      season
        ? (await this.db.select().from(seasonCups).where(eq(seasonCups.seasonId, season.id))).filter((c) => c.confirmedAt).map((c) => c.competition)
        : [],
    );
    return {
      pendingMatches: pending.matches.length,
      standingsNotConfirmed: tables.filter((t) => t.confirmedAt === null).map((t) => t.competition),
      cupsNotConfirmed: CUP_COMPETITIONS.filter((c) => !confirmedCups.has(c)),
      suspendedClubs: suspension.clubs.map((c) => c.ticker),
      marketSuspended: suspension.market !== null,
      ipoBlockers,
      ipoSettlementFailures: [...this.ipoSettlement.failures()],
      pendingPayouts: outstanding.pending,
      settlingPayouts: outstanding.settling,
      correctionToApply: outstanding.correctionEvents > 0,
    };
  }
}

@AdminOnly()
@Controller("admin/overview")
export class OverviewController {
  constructor(private readonly overview: OverviewService) {}

  @Get()
  get(): Promise<Overview> {
    return this.overview.compute();
  }
}
