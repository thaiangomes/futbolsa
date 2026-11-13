import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { ADMIN_ERROR_MESSAGES, adjustResponseSchema, type AdjustBody, type AdjustResponse } from "@futbolsa/contracts";
import { Clock } from "../../../infra/clock/index.js";
import { DB, type Database, lockClubs, lockSeason, lockWallets, withTransaction } from "../../../infra/db/index.js";
import { clubs, positions, seasonClubs, users, wallets } from "../../../infra/db/schema/index.js";
import { DomainError } from "../../../infra/http/index.js";
import { displayedPriceOf } from "../../market/state/displayed-price.js";
import { claimIdempotencyKey, requestHash, saveIdempotentResponse } from "../../market/orders/idempotency.js";
import { PortfolioLedger } from "../../portfolio/portfolio.module.js";
import { WalletEvents } from "../../portfolio/wallet-events.js";
import type { PostResult } from "../../portfolio/ledger/post.js";
import { currentSeason } from "../current-season.js";
import { AdminLogService } from "../log/index.js";
import { adjustPlan, type AdjustRefusal } from "./adjust.rules.js";

const ROUTE = "POST /admin/players/:id/adjust";
const STATUS: Record<AdjustRefusal | "player_not_found" | "no_wallet" | "no_season" | "club_not_listed", number> = {
  adjust_insufficient_cash: 422,
  adjust_insufficient_shares: 422,
  treasury_insufficient_shares: 422,
  adjust_not_allowed: 409,
  player_not_found: 404,
  no_wallet: 409,
  no_season: 409,
  club_not_listed: 404,
};
const fail = (code: keyof typeof STATUS) => new DomainError(code, STATUS[code], ADMIN_ERROR_MESSAGES[code]);

/**
 * Ajustar saldo (Admin, critérios 27, 28 e 33; T5 da F14): o admin credita ou debita caixa ou ações de um jogador, com
 * motivo. As ações saem da tesouraria e voltam para ela; o crédito de ações custa o **preço exibido** no momento do
 * crédito; o caixa não passa pela tesouraria (proposta 4). A regra é a `adjustPlan`, pura.
 *
 * Travas, na ordem do jogo: a linha do usuário (compartilhada, para a conta não ser excluída no meio), a temporada
 * (compartilhada), o clube (quando são ações: lê o preço e as reservas da casa sem mudar), a carteira e a tesouraria por
 * último. Chamada repetida não duplica: a `Idempotency-Key` vai para `idempotency_keys` na mesma transação (proposta 7).
 */
@Injectable()
export class AdjustService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly clock: Clock,
    private readonly log: AdminLogService,
    private readonly ledger: PortfolioLedger,
    private readonly walletEvents: WalletEvents,
  ) {}

  async adjust(adminId: string, targetId: string, body: AdjustBody, key: string): Promise<AdjustResponse> {
    const now = this.clock.now();
    const ref = { userId: adminId, key, requestHash: requestHash(`${ROUTE}|${targetId}`, { ...body }) };
    return withTransaction(this.db, async (tx) => {
      const claim = await claimIdempotencyKey(tx, ref, now);
      if (claim.kind === "replay") return adjustResponseSchema.parse(claim.response.body);
      if (claim.kind === "conflict") throw new DomainError("idempotency_conflict", 409, ADMIN_ERROR_MESSAGES.idempotency_conflict);

      const [user] = await tx.db.select({ status: users.status }).from(users).where(eq(users.id, targetId)).for("share");
      if (!user || user.status === "deleted") throw fail("player_not_found");
      const season0 = await currentSeason(tx.db);
      if (!season0) throw fail("no_season");
      const season = await lockSeason(tx, season0.id, "share");

      let clubId: number | undefined;
      let price: number | null = null;
      if (body.asset === "shares") {
        const [club] = await tx.db
          .select({ id: clubs.id })
          .from(seasonClubs)
          .innerJoin(clubs, eq(clubs.id, seasonClubs.clubId))
          .where(and(eq(seasonClubs.seasonId, season.id), eq(clubs.ticker, body.ticker!)));
        if (!club) throw fail("club_not_listed");
        clubId = club.id;
        const [locked] = await lockClubs(tx, season.id, [body.ticker!]);
        price = displayedPriceSafe(locked!);
      }
      const [own] = await tx.db
        .select({ id: wallets.id })
        .from(wallets)
        .where(and(eq(wallets.seasonId, season.id), eq(wallets.userId, targetId)));
      if (!own) throw fail("no_wallet");
      const [treasury] = await tx.db
        .select({ id: wallets.id })
        .from(wallets)
        .where(and(eq(wallets.seasonId, season.id), eq(wallets.ownerType, "treasury")));
      const rows = await lockWallets(tx, treasury ? [own.id, treasury.id] : [own.id]);
      const ownRow = rows.find((w) => w.id === own.id)!;
      const positionOf = async (walletId: number) => {
        if (clubId === undefined) return null;
        const [p] = await tx.db
          .select({ shares: positions.shares, reservedShares: positions.reservedShares })
          .from(positions)
          .where(and(eq(positions.walletId, walletId), eq(positions.clubId, clubId)));
        return p ?? null;
      };

      const plan = adjustPlan({
        asset: body.asset,
        delta: body.delta,
        seasonStatus: season.status as Parameters<typeof adjustPlan>[0]["seasonStatus"],
        wallet: { cash: ownRow.cash, reservedCash: ownRow.reservedCash },
        position: await positionOf(own.id),
        treasuryPosition: treasury ? await positionOf(treasury.id) : null,
        price,
      });
      if (!plan.ok) throw fail(plan.code);
      if (body.asset === "shares" && !treasury) throw fail("treasury_insufficient_shares");

      // o registro vem antes dos movimentos só porque o `ref` deles é o id dele; o antes e o depois completam-se logo abaixo
      const beforeOwn = await positionOf(own.id);
      const beforeTreasury = treasury ? await positionOf(treasury.id) : null;
      const logId = await this.log.record(tx, {
        actorId: adminId,
        action: "player.adjust",
        targetType: "player",
        targetId,
        reason: body.reason,
        before: {
          asset: body.asset,
          ticker: body.ticker ?? null,
          cash: ownRow.cash,
          shares: beforeOwn?.shares ?? 0,
          treasuryShares: beforeTreasury?.shares ?? null,
        },
        after: {
          delta: body.delta,
          price,
          cash: body.asset === "cash" ? ownRow.cash + body.delta : ownRow.cash,
          shares: (beforeOwn?.shares ?? 0) + (body.asset === "shares" ? body.delta : 0),
          treasuryShares: treasury ? (beforeTreasury?.shares ?? 0) - (body.asset === "shares" ? body.delta : 0) : null,
        },
      });

      const posted: Array<{ result: PostResult; ticker?: string }> = [];
      for (const m of plan.movements) {
        const result = await this.ledger.post(tx, {
          walletId: m.owner === "player" ? own.id : treasury!.id,
          at: now,
          kind: "adjustment",
          ...(clubId !== undefined ? { clubId } : {}),
          ...(m.cashDelta !== undefined ? { cashDelta: m.cashDelta } : {}),
          ...(m.sharesDelta !== undefined ? { sharesDelta: m.sharesDelta } : {}),
          ...(m.costBasis ? { costBasis: m.costBasis } : {}),
          ...(m.price !== undefined ? { price: m.price } : {}),
          ref: { type: "admin_log", id: logId },
          reason: body.reason,
        });
        posted.push({ result, ...(body.ticker ? { ticker: body.ticker } : {}) });
      }
      for (const p of posted) await this.walletEvents.posted(tx, p.result, p.ticker);

      const mine = posted[0]!.result;
      const response: AdjustResponse = {
        asset: body.asset,
        ticker: body.ticker ?? null,
        delta: body.delta,
        price: body.asset === "shares" ? price : null,
        after: body.asset === "cash" ? mine.wallet.cash : (mine.position?.shares ?? 0),
      };
      await saveIdempotentResponse(tx, ref, { status: 200, body: response });
      return response;
    });
  }
}

/** O preço exibido da linha travada do clube; clube sem preço nenhum não se ajusta. */
function displayedPriceSafe(club: { lastPrice: number | null; ipoPrice: number | null }): number | null {
  try {
    return displayedPriceOf(club);
  } catch {
    return null;
  }
}
