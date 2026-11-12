import { Controller, Get, Inject } from "@nestjs/common";
import { and, asc, eq, sql } from "drizzle-orm";
import { COMMON_ERROR_MESSAGES, type EquityResponse } from "@futbolsa/contracts";
import { CurrentUser, type ResolvedUser } from "../../../infra/auth-adapter/index.js";
import { DB, type Database } from "../../../infra/db/index.js";
import { equityDaily, wallets } from "../../../infra/db/schema/index.js";
import { DomainError } from "../../../infra/http/index.js";
import { currentSeason } from "../../admin/current-season.js";
import { EQUITY_BASE_CENTS } from "../valuation/constants.js";
import { WALLET_NOT_FOUND, WalletService } from "../wallet/wallet.service.js";

/** `GET /portfolio/equity`: o ponto de entrada (R$ 100.000,00), um ponto por dia fechado, o valor atual e os dias com dividendo. */
@Controller("portfolio/equity")
export class EquityController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly wallet: WalletService,
  ) {}

  @Get()
  async get(@CurrentUser() user: ResolvedUser): Promise<EquityResponse> {
    const season = await currentSeason(this.db);
    if (!season) throw new DomainError(WALLET_NOT_FOUND, 404, COMMON_ERROR_MESSAGES.not_found);
    const [row] = await this.db
      .select({ id: wallets.id, enteredAt: wallets.enteredAt })
      .from(wallets)
      .where(and(eq(wallets.seasonId, season.id), eq(wallets.userId, user.id)));
    if (!row) throw new DomainError(WALLET_NOT_FOUND, 404, "Você ainda não entrou na temporada.");
    const points = await this.db
      .select({ day: equityDaily.day, equity: equityDaily.equity })
      .from(equityDaily)
      .where(eq(equityDaily.walletId, row.id))
      .orderBy(asc(equityDaily.day));
    // dividendo, estorno e complemento somados por dia de Brasília (o mesmo dia que `dayStart` do motor)
    const days = await this.db.execute(sql`
      select to_char((e.at at time zone 'America/Sao_Paulo')::date, 'YYYY-MM-DD') as day, sum(e.cash_delta)::bigint as total
      from futbolsa.wallet_entries e
      where e.wallet_id = ${row.id} and e.kind in ('dividend', 'reversal', 'complement')
      group by 1 having sum(e.cash_delta) <> 0 order by 1`);
    const view = await this.wallet.view(row.id);
    return {
      base: EQUITY_BASE_CENTS,
      startedAt: row.enteredAt.toISOString(),
      points,
      current: { at: view.at, equity: view.equity },
      dividendDays: days.rows.map((r) => ({ day: String(r.day), total: Number(r.total) })),
    };
  }
}
