import { createHmac } from "node:crypto";
import { returnBp as engineReturnBp } from "@futbolsa/engine";
import type { RankingRow } from "@futbolsa/contracts";
import type { Tx } from "../../infra/db/transaction.js";
import { identities } from "./participants.js";

const KEY_SALT = process.env.RANKINGS_KEY_SALT ?? "futbolsa-rankings";

/** A chave opaca de uma linha: não é o id da carteira, e muda de uma temporada para a outra. */
export function walletKey(seasonId: number, walletId: number): string {
  return createHmac("sha256", KEY_SALT).update(`${seasonId}:${walletId}`).digest("base64url").slice(0, 16);
}

/** O retorno em pontos-base, ou nulo para quem está sem base (base ≤ 0). */
export function returnOf(equity: number, base: number): number | null {
  return base > 0 ? engineReturnBp(equity, base) : null;
}

export interface PositionedRow {
  walletId: number;
  position: number;
  returnBp: number | null;
}

/** Monta as linhas de uma página como a tela vê: apelido atual, "conta excluída" (nome nulo), bot marcado, nada de patrimônio. */
export async function toRankingRows(tx: Pick<Tx, "db">, seasonId: number, rows: readonly PositionedRow[]): Promise<RankingRow[]> {
  const ids = await identities(tx, rows.map((r) => r.walletId));
  return rows.map((r) => {
    const who = ids.get(r.walletId);
    return {
      position: r.position,
      walletKey: walletKey(seasonId, r.walletId),
      displayName: who?.displayName ?? null,
      isBot: who?.isBot ?? false,
      botLabel: who?.botLabel ?? null,
      returnBp: r.returnBp,
    };
  });
}
