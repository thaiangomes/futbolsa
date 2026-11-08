import { Controller, Get, Inject } from "@nestjs/common";
import { asc, isNotNull } from "drizzle-orm";
import type { KnownClubsResponse } from "@futbolsa/contracts";
import { AdminOnly } from "../../../infra/auth-adapter/index.js";
import { DB, type Database } from "../../../infra/db/index.js";
import { clubs } from "../../../infra/db/schema/index.js";

/** Os clubes com ticker, para o admin escolher a lista da temporada (só quem tem ticker pode ser listado). */
@AdminOnly()
@Controller("admin/clubs")
export class ClubsController {
  constructor(@Inject(DB) private readonly db: Database) {}

  @Get()
  async list(): Promise<KnownClubsResponse> {
    const rows = await this.db.select().from(clubs).where(isNotNull(clubs.ticker)).orderBy(asc(clubs.ticker));
    return { clubs: rows.map((c) => ({ id: c.id, ticker: c.ticker, name: c.name })) };
  }
}
