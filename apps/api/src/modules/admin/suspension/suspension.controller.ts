import { Body, Controller, Delete, Get, HttpCode, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { type SuspendBody, suspendBodySchema, type SuspensionState } from "@futbolsa/contracts";
import { AdminOnly, CurrentUser, type ResolvedUser } from "../../../infra/auth-adapter/index.js";
import { ZodValidationPipe } from "../../../infra/http/index.js";
import { SuspensionService } from "./suspension.service.js";

const tickerPipe = new ZodValidationPipe(z.string().regex(/^[A-Z]{3,5}\d{1,2}$/));

/** Suspensão da negociação de um clube ou do mercado todo, com motivo (Admin, critérios 23, 24 e 33). */
@AdminOnly()
@Controller("admin/suspensions")
export class SuspensionController {
  constructor(private readonly suspension: SuspensionService) {}

  @Get()
  state(): Promise<SuspensionState> {
    return this.suspension.state();
  }

  /** Com `ticker`, suspende o clube; sem, o mercado todo. */
  @HttpCode(200)
  @Post()
  suspend(
    @CurrentUser() admin: ResolvedUser,
    @Body(new ZodValidationPipe(suspendBodySchema)) body: SuspendBody,
  ): Promise<SuspensionState> {
    return this.suspension.suspend(admin.id, body);
  }

  /** Retoma o mercado todo. */
  @Delete()
  resumeMarket(@CurrentUser() admin: ResolvedUser): Promise<SuspensionState> {
    return this.suspension.resume(admin.id, undefined);
  }

  @Delete(":ticker")
  resumeClub(@CurrentUser() admin: ResolvedUser, @Param("ticker", tickerPipe) ticker: string): Promise<SuspensionState> {
    return this.suspension.resume(admin.id, ticker);
  }
}
