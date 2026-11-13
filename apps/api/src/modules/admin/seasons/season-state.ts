import { eq } from "drizzle-orm";
import { ADMIN_ERROR_MESSAGES } from "@futbolsa/contracts";
import { type Database, type DrizzleTx, Tx } from "../../../infra/db/index.js";
import { seasons } from "../../../infra/db/schema/index.js";
import { DomainError } from "../../../infra/http/index.js";

/**
 * O congelamento da temporada encerrada (F15, T7; Admin, critério 18): depois do encerramento, nenhuma escrita muda
 * a temporada. Cada serviço dono de uma escrita chama o guard com a linha da temporada que ele já leu (de preferência
 * travada, para o encerramento não passar no meio) ou com o id.
 */
export const seasonClosedError = () => new DomainError("season_closed", 409, ADMIN_ERROR_MESSAGES.season_closed);

/** Recusa com `season_closed` se a temporada está encerrada. */
export function assertSeasonOpen(season: { status: string } | null | undefined): void {
  if (season?.status === "closed") throw seasonClosedError();
}

/** Como `assertSeasonOpen`, lendo a temporada pelo id (sem travar). Temporada inexistente passa: quem chama decide o 404. */
export async function assertSeasonIdOpen(executor: Tx | Database | DrizzleTx, seasonId: number): Promise<void> {
  const db = executor instanceof Tx ? executor.db : executor;
  const [season] = await db.select({ status: seasons.status }).from(seasons).where(eq(seasons.id, seasonId));
  assertSeasonOpen(season);
}
