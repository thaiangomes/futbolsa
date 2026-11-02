import { and, eq, inArray, notExists, sql } from "drizzle-orm";
import type { Cents } from "@futbolsa/engine";
import { lockSeason, type Tx } from "../../infra/db/index.js";
import { users, wallets } from "../../infra/db/schema/index.js";
import type { PortfolioLedger } from "../portfolio/index.js";

/** R$ 100.000,00: o caixa de toda conta de jogador no início de cada temporada (Conta e login). */
export const SEASON_START_CASH: Cents = 10_000_000;

/**
 * A abertura das ofertas do IPO é o início da temporada: toda conta de jogador, ativa ou
 * bloqueada, que ainda não tem carteira nela passa a ter R$ 100.000,00 em caixa e nenhuma ação
 * (Conta e login, critérios 12, 17 e 18). Conta excluída fica de fora. Repetível: quem já tem
 * carteira é pulado, então rodar duas vezes não credita duas vezes.
 *
 * Chamado pela F8 na transação da tarefa que abre o IPO. Trava a temporada em modo exclusivo:
 * o cadastro trava em modo compartilhado, então quem se cadastra antes entra nesta lista, e quem
 * se cadastra depois já vê o IPO aberto e abre a própria carteira.
 */
export async function creditSeasonStart(
  ledger: PortfolioLedger,
  tx: Tx,
  seasonId: number,
  at: Date,
): Promise<number> {
  await lockSeason(tx, seasonId, "update");
  const pending = await tx.db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        inArray(users.status, ["active", "blocked"]),
        notExists(
          tx.db
            .select({ one: sql`1` })
            .from(wallets)
            .where(and(eq(wallets.seasonId, seasonId), eq(wallets.userId, users.id))),
        ),
      ),
    )
    .orderBy(users.createdAt, users.id);
  for (const user of pending) {
    await ledger.openWallet(tx, {
      seasonId,
      owner: { type: "user", userId: user.id },
      at,
      entryMode: "ipo",
      initialCash: SEASON_START_CASH,
    });
  }
  return pending.length;
}
