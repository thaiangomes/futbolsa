import { Controller, Get, Param, Query } from "@nestjs/common";
import { type ChartQuery, chartQuerySchema, clubTickerParamSchema, type MarkersResponse, type MyTradesResponse } from "@futbolsa/contracts";
import { CurrentUser, Public, type ResolvedUser } from "../../../infra/auth-adapter/index.js";
import { ZodValidationPipe } from "../../../infra/http/index.js";
import { MarkersService } from "./markers.service.js";

const tickerPipe = new ZodValidationPipe(clubTickerParamSchema);
const queryPipe = new ZodValidationPipe(chartQuerySchema);

/** `GET /clubs/:ticker/markers`: jogos e dividendos, público e igual para todos. */
@Controller("clubs")
export class MarkersController {
  constructor(private readonly markers: MarkersService) {}

  @Public()
  @Get(":ticker/markers")
  get(@Param("ticker", tickerPipe) ticker: string, @Query(queryPipe) query: ChartQuery): Promise<MarkersResponse> {
    return this.markers.public(ticker, query.range);
  }
}

/** `GET /portfolio/clubs/:ticker/trades`: os meus negócios e o meu preço médio no clube, só do dono (com login). */
@Controller("portfolio/clubs")
export class MyTradesController {
  constructor(private readonly markers: MarkersService) {}

  @Get(":ticker/trades")
  get(@CurrentUser() user: ResolvedUser, @Param("ticker", tickerPipe) ticker: string, @Query(queryPipe) query: ChartQuery): Promise<MyTradesResponse> {
    return this.markers.mine(user.id, ticker, query.range);
  }
}
