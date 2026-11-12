import { Controller, Get, Query } from "@nestjs/common";
import { type EntriesQuery, type EntriesResponse, entriesQuerySchema } from "@futbolsa/contracts";
import { CurrentUser, type ResolvedUser } from "../../../infra/auth-adapter/index.js";
import { ZodValidationPipe } from "../../../infra/http/index.js";
import { EntriesService } from "./entries.service.js";

/** `GET /portfolio/entries`: o extrato do jogador logado, sem a contraparte. */
@Controller("portfolio/entries")
export class EntriesController {
  constructor(private readonly entries: EntriesService) {}

  @Get()
  list(@CurrentUser() user: ResolvedUser, @Query(new ZodValidationPipe(entriesQuerySchema)) query: EntriesQuery): Promise<EntriesResponse> {
    return this.entries.listForUser(user.id, query);
  }
}
