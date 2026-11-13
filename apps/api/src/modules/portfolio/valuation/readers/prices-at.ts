import type { Cents } from "@futbolsa/engine";
import { sql } from "drizzle-orm";
import type { Tx } from "../../../../infra/db/transaction.js";
import { displayedPrices } from "../../../market/state/displayed-price.js";

export interface ClubPrice {
  clubId: number;
  ticker: string;
  price: Cents;
}

/**
 * O preço exibido de cada clube listado em `at`, pela regra do dono (`market`: o último negócio até `at`, ou o preço
 * do IPO). Uma consulta de preços e uma da lista de ids, não importa quantas carteiras.
 */
export async function pricesAt(tx: Tx, seasonId: number, at: Date, options: { ignoreTrades?: ReadonlySet<number> } = {}): Promise<Map<number, ClubPrice>> {
  const byTicker = await displayedPrices(tx.db, seasonId, at, options);
  const rows = await tx.db.execute(sql`
    select c.id as club_id, c.ticker from futbolsa.season_clubs sc join futbolsa.clubs c on c.id = sc.club_id where sc.season_id = ${seasonId}`);
  const out = new Map<number, ClubPrice>();
  for (const r of rows.rows) {
    const ticker = String(r.ticker);
    out.set(Number(r.club_id), { clubId: Number(r.club_id), ticker, price: byTicker.get(ticker) ?? 0 });
  }
  return out;
}
