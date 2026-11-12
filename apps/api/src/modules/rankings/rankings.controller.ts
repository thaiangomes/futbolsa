import { Controller, Get, Param, Query } from "@nestjs/common";
import {
  liveQuerySchema,
  rankingPageQuerySchema,
  type LiveQuery,
  type LiveRanking,
  type OfficialRanking,
  type RankingHistory,
  type RankingPageQuery,
} from "@futbolsa/contracts";
import { CurrentAuth, Public, type RequestAuth } from "../../infra/auth-adapter/index.js";
import { ZodValidationPipe } from "../../infra/http/index.js";
import { LiveService } from "./live.service.js";
import { OfficialService } from "./official.service.js";

const pageQuery = new ZodValidationPipe(rankingPageQuerySchema);
const liveQuery = new ZodValidationPipe(liveQuerySchema);

/** Rotas dos rankings: todas públicas (P7: nenhuma devolve patrimônio ou base em R$). Com login, a parcial traz também a linha de quem pediu. */
@Controller("rankings")
export class RankingsController {
  constructor(
    private readonly live: LiveService,
    private readonly official: OfficialService,
  ) {}

  @Public()
  @Get("live")
  liveRanking(@Query(liveQuery) query: LiveQuery, @CurrentAuth() auth: RequestAuth | undefined): Promise<LiveRanking> {
    return this.live.view({ ...query, userId: auth?.user?.id });
  }

  @Public()
  @Get("history")
  history(): Promise<RankingHistory> {
    return this.official.history();
  }

  @Public()
  @Get("month/:key")
  month(@Param("key") key: string, @Query(pageQuery) query: RankingPageQuery): Promise<OfficialRanking> {
    return this.official.month(key, query);
  }

  @Public()
  @Get("season/:year")
  season(@Param("year") year: string, @Query(pageQuery) query: RankingPageQuery): Promise<OfficialRanking> {
    return this.official.season(year, query);
  }
}
