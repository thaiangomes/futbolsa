import { Body, Controller, Get, Patch } from "@nestjs/common";
import { type MarketMakerBody, marketMakerBodySchema, type MarketMakerState, type MarketMakerView } from "@futbolsa/contracts";
import { AdminOnly, CurrentUser, type ResolvedUser } from "../../../infra/auth-adapter/index.js";
import { ZodValidationPipe } from "../../../infra/http/index.js";
import { MarketMakerAdminService } from "./market-maker.service.js";

/** Percentuais da quantidade do formador de mercado, com motivo (Livro de ofertas, critério 34). */
@AdminOnly()
@Controller("admin/market-maker")
export class MarketMakerAdminController {
  constructor(private readonly service: MarketMakerAdminService) {}

  @Get()
  view(): Promise<MarketMakerView> {
    return this.service.view();
  }

  @Patch()
  update(
    @CurrentUser() admin: ResolvedUser,
    @Body(new ZodValidationPipe(marketMakerBodySchema)) body: MarketMakerBody,
  ): Promise<MarketMakerState> {
    return this.service.update(admin.id, body);
  }
}
