import { Controller, Get, Param, Query } from "@nestjs/common";
import { type CandlesResponse, type ChartQuery, chartQuerySchema, clubTickerParamSchema } from "@futbolsa/contracts";
import { Public } from "../../../infra/auth-adapter/index.js";
import { ZodValidationPipe } from "../../../infra/http/index.js";
import { CandlesService } from "./candles.service.js";

/** `GET /clubs/:ticker/candles?range=today|7d|30d|season`: público. */
@Controller("clubs")
export class CandlesController {
  constructor(private readonly candles: CandlesService) {}

  @Public()
  @Get(":ticker/candles")
  get(
    @Param("ticker", new ZodValidationPipe(clubTickerParamSchema)) ticker: string,
    @Query(new ZodValidationPipe(chartQuerySchema)) query: ChartQuery,
  ): Promise<CandlesResponse> {
    return this.candles.get(ticker, query.range);
  }
}
