import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { Projection, ProjectionBody, ProjectionList } from "@futbolsa/contracts";
import { Clock } from "../../../infra/clock/index.js";
import { DB, type Database } from "../../../infra/db/index.js";
import { clubProjections, clubs, seasonClubs } from "../../../infra/db/schema/index.js";
import { DomainError } from "../../../infra/http/index.js";
import { currentSeason } from "../../admin/current-season.js";

const notListed = () => new DomainError("club_not_listed", 404, "Este clube não está listado na temporada.");

/**
 * As projeções do próprio jogador (critérios 54 a 56 do livro). Só premissas: o valor e a marca "desatualizada" saem no
 * navegador, com o `clubValue` do motor e os dividendos públicos do clube. Sempre filtra pelo dono; nada daqui chega a
 * outro jogador, à casa ou aos bots.
 */
@Injectable()
export class ProjectionsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  async list(userId: string): Promise<ProjectionList> {
    const season = await currentSeason(this.db);
    if (!season) return { projections: [] };
    const rows = await this.db
      .select({ ticker: clubs.ticker, points: clubProjections.points, position: clubProjections.position, cups: clubProjections.cups, updatedAt: clubProjections.updatedAt })
      .from(clubProjections)
      .innerJoin(clubs, eq(clubs.id, clubProjections.clubId))
      .where(and(eq(clubProjections.seasonId, season.id), eq(clubProjections.userId, userId)))
      .orderBy(clubs.ticker);
    return { projections: rows.map((r) => ({ ticker: r.ticker!, points: r.points, position: r.position, cups: r.cups, updatedAt: r.updatedAt.toISOString() })) };
  }

  /** Salva (ou troca) a projeção do jogador para o clube: uma por clube. Recusa clube não listado na temporada. */
  async save(userId: string, ticker: string, body: ProjectionBody): Promise<Projection> {
    const season = await currentSeason(this.db);
    if (!season) throw notListed();
    const [club] = await this.db
      .select({ clubId: seasonClubs.clubId })
      .from(seasonClubs)
      .innerJoin(clubs, eq(clubs.id, seasonClubs.clubId))
      .where(and(eq(seasonClubs.seasonId, season.id), eq(clubs.ticker, ticker)));
    if (!club) throw notListed();
    const updatedAt = this.clock.now();
    const values = { points: body.points, position: body.position, cups: body.cups, updatedAt };
    await this.db
      .insert(clubProjections)
      .values({ seasonId: season.id, userId, clubId: club.clubId, ...values })
      .onConflictDoUpdate({ target: [clubProjections.seasonId, clubProjections.userId, clubProjections.clubId], set: values });
    return { ticker, ...body, updatedAt: updatedAt.toISOString() };
  }
}
