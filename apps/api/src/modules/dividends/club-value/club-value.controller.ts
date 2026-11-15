import { Controller, Get, Param } from "@nestjs/common";
import { type ClubValueView, clubTickerParamSchema } from "@futbolsa/contracts";
import { Public } from "../../../infra/auth-adapter/index.js";
import { ZodValidationPipe } from "../../../infra/http/index.js";
import { ClubValueService } from "./club-value.service.js";

const tickerPipe = new ZodValidationPipe(clubTickerParamSchema);

/** `GET /clubs/:ticker/dividends` (T12): o que o cartão "Quanto vale para você" da tela do clube precisa. Pública. */
@Controller("clubs")
export class ClubValueController {
  constructor(private readonly values: ClubValueService) {}

  @Public()
  @Get(":ticker/dividends")
  dividends(@Param("ticker", tickerPipe) ticker: string): Promise<ClubValueView> {
    return this.values.view(ticker);
  }
}
