import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { EntryPreview } from "@futbolsa/contracts";
import { entryQuote, referencePrice } from "@futbolsa/engine";
import { Clock } from "../../infra/clock/index.js";
import { DB, type Database, type DrizzleTx } from "../../infra/db/index.js";
import { clubs, seasonClubs } from "../../infra/db/schema/index.js";
import { readAvailability, statusOf, type EntryOwner } from "./availability.js";
import { entryError } from "./errors.js";

type Db = Database | DrizzleTx;

/** Os preços de referência dos clubes listados, por ticker, ou `null` se algum clube ainda não tem preço. */
export async function readReferencePrices(db: Db, seasonId: number): Promise<Record<string, number> | null> {
  const rows = await db
    .select({ ticker: clubs.ticker, lastPrice: seasonClubs.lastPrice, ipoPrice: seasonClubs.ipoPrice })
    .from(seasonClubs)
    .innerJoin(clubs, eq(clubs.id, seasonClubs.clubId))
    .where(eq(seasonClubs.seasonId, seasonId));
  if (rows.length === 0) return null;
  const prices: Record<string, number> = {};
  for (const r of rows) {
    if (r.lastPrice === null && r.ipoPrice === null) return null;
    prices[r.ticker!] = referencePrice(r);
  }
  return prices;
}

/**
 * `GET /entry/preview` (P8): lê os preços com `SELECT` comum, sem `FOR UPDATE`, e calcula com a mesma função da
 * confirmação. Mostrar a prévia nunca para o mercado, e a confirmação vale o preço do momento dela.
 */
@Injectable()
export class EntryPreviewService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  async preview(owner: EntryOwner): Promise<EntryPreview> {
    if (owner.type === "user" && owner.status === "blocked") throw entryError("account_blocked");
    const status = await readAvailability(this.db, owner, this.clock.now());
    if (status.availability !== "open") {
      return { availability: status.availability, message: status.message, ...(status.mode ? { mode: status.mode } : {}) };
    }
    const prices = await readReferencePrices(this.db, status.seasonId!);
    if (!prices) return { availability: "settling", message: statusOf("settling").message };
    return { availability: "open", defaultMode: "index", quote: entryQuote(prices) };
  }
}
