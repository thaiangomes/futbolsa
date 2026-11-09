import { Body, Controller, Delete, Param, Put } from "@nestjs/common";
import {
  type DeleteBidResponse,
  putBidBodySchema,
  type PutBidBody,
  type PutBidResponse,
  tickerParamSchema,
} from "@futbolsa/contracts";
import { CurrentUser, type ResolvedUser } from "../../infra/auth-adapter/index.js";
import { RateLimit, ZodValidationPipe } from "../../infra/http/index.js";
import { IpoBidsService } from "./bids.service.js";

const tickerPipe = new ZodValidationPipe(tickerParamSchema);

/**
 * As ofertas do próprio jogador no IPO. Login padrão do jogo (o guard recusa e-mail não confirmado,
 * Conta e login 5); a regra de quem pode ofertar (bloqueado, caixa negativo) fica no serviço, dentro
 * da transação. O controlador só acha a carteira do usuário: o serviço é o mesmo dos bots.
 */
@RateLimit("bids")
@Controller("ipo/bids")
export class IpoBidsController {
  constructor(private readonly bids: IpoBidsService) {}

  @Put(":ticker")
  async put(
    @CurrentUser() user: ResolvedUser,
    @Param("ticker", tickerPipe) ticker: string,
    @Body(new ZodValidationPipe(putBidBodySchema)) body: PutBidBody,
  ): Promise<PutBidResponse> {
    return this.bids.place(await this.bids.walletOf(user.id), ticker, body);
  }

  @Delete(":ticker")
  async remove(@CurrentUser() user: ResolvedUser, @Param("ticker", tickerPipe) ticker: string): Promise<DeleteBidResponse> {
    return this.bids.cancel(await this.bids.walletOf(user.id), ticker);
  }
}
