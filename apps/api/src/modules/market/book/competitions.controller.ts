import { Controller, Get, Inject, Param } from "@nestjs/common";
import { type CompetitionView, competitionParamSchema } from "@futbolsa/contracts";
import { Clock } from "../../../infra/clock/index.js";
import { DB, type Database } from "../../../infra/db/index.js";
import { Public } from "../../../infra/auth-adapter/index.js";
import { ZodValidationPipe } from "../../../infra/http/index.js";
import { currentSeason } from "../../admin/current-season.js";
import { competitionView } from "./competitions-repo.js";

const competitionPipe = new ZodValidationPipe(competitionParamSchema);

/** `GET /competitions/:competition` (item 11 da fila da partida de teste): a classificação e os jogos da competição na temporada. Pública. */
@Controller("competitions")
export class CompetitionsController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  @Public()
  @Get(":competition")
  async one(@Param("competition", competitionPipe) competition: CompetitionView["competition"]): Promise<CompetitionView> {
    const season = await currentSeason(this.db);
    if (!season) return { competition, standings: [], stages: [] };
    return competitionView(this.db, season.id, competition, this.clock.now());
  }
}
