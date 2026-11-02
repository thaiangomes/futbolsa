import { Controller, Get } from "@nestjs/common";
import { Public } from "./infra/auth-adapter/index.js";
import { MIN_PRICE } from "@futbolsa/engine";
import { healthResponseSchema, type HealthResponse } from "@futbolsa/contracts";

@Controller("health")
export class HealthController {
  /** Prova de vida: a resposta só sai se a API enxergar o motor e obedecer o contrato. */
  @Public()
  @Get()
  check(): HealthResponse {
    return healthResponseSchema.parse({ status: "ok", minPrice: MIN_PRICE });
  }
}
