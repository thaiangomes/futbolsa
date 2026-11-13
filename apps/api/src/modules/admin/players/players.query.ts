import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gt, ilike, or, sql, type SQL } from "drizzle-orm";
import {
  ADMIN_ERROR_MESSAGES,
  type EntriesQuery,
  type EntriesResponse,
  type PlayerDetail,
  type PlayerListItem,
  type PlayersList,
  type PlayersQuery,
} from "@futbolsa/contracts";
import { COMMON_ERROR_MESSAGES } from "@futbolsa/contracts";
import { DB, type Database } from "../../../infra/db/index.js";
import { clubs, fraudWarnings, ipoBids, orders, users, wallets } from "../../../infra/db/schema/index.js";
import { DomainError } from "../../../infra/http/index.js";
import { myOrderView } from "../../market/orders/views.js";
import { toOrderRecord } from "../../market/matching/settle.js";
import { EntriesService } from "../../portfolio/entries/entries.service.js";
import { WalletService } from "../../portfolio/wallet/wallet.service.js";
import { currentSeason } from "../current-season.js";

const PAGE = 50;
/** Depois do último apelido possível: conta excluída (sem apelido) vai para o fim da lista. */
const LAST_KEY = String.fromCodePoint(0x10ffff);

const notFound = () => new DomainError("player_not_found", 404, ADMIN_ERROR_MESSAGES.player_not_found);

/** Escapa `%`, `_` e `\` do `LIKE`: o prefixo é do admin, mas não vale como curinga. */
function likePrefix(q: string): string {
  return `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Ver jogadores (T2 da F14): lista com busca, detalhe e extrato. Só leitura. A carteira e o extrato vêm dos mesmos
 * serviços que o jogador usa (`WalletService.view`, `EntriesService.list`), recebendo a carteira por parâmetro; a
 * conta excluída aparece sem dado nenhum. O e-mail só aparece no detalhe e na busca exata (proposta 3).
 */
@Injectable()
export class PlayersQueryService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly walletService: WalletService,
    private readonly entriesService: EntriesService,
  ) {}

  async list(query: PlayersQuery): Promise<PlayersList> {
    const key = sql<string>`coalesce(lower(${users.nickname}), ${LAST_KEY})`;
    const filters: SQL[] = [];
    if (query.status) filters.push(eq(users.status, query.status));
    if (query.role) filters.push(eq(users.role, query.role));
    if (query.q) {
      // com "@" é e-mail e só acha o exato; sem, é prefixo do apelido
      filters.push(
        query.q.includes("@")
          ? sql`lower(${users.email}) = ${query.q.toLowerCase()}`
          : (ilike(users.nickname, likePrefix(query.q)) as SQL),
      );
    }
    if (query.cursor) {
      const [k, id] = splitCursor(query.cursor);
      filters.push(or(gt(key, k), and(eq(key, k), gt(sql<string>`${users.id}::text`, id)))!);
    }
    const rows = await this.db
      .select({ user: users, key })
      .from(users)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(asc(key), asc(users.id))
      .limit(PAGE + 1);
    const page = rows.slice(0, PAGE);
    const season = await currentSeason(this.db);
    const items: PlayerListItem[] = [];
    for (const { user } of page) {
      let equity: number | null = null;
      if (season && user.status !== "deleted") {
        const [wallet] = await this.db
          .select({ id: wallets.id })
          .from(wallets)
          .where(and(eq(wallets.seasonId, season.id), eq(wallets.userId, user.id)));
        if (wallet) equity = (await this.walletService.view(wallet.id)).equity;
      }
      items.push({
        id: user.id,
        nickname: user.nickname,
        role: user.role as PlayerListItem["role"],
        status: user.status as PlayerListItem["status"],
        createdAt: user.createdAt.toISOString(),
        equity,
      });
    }
    const last = page[page.length - 1];
    return { items, nextCursor: rows.length > PAGE && last ? `${last.key}\u0000${last.user.id}` : null };
  }

  async detail(userId: string): Promise<PlayerDetail> {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!user) throw notFound();
    const deleted = user.status === "deleted";
    const account: PlayerDetail["account"] = {
      id: user.id,
      nickname: deleted ? null : user.nickname,
      email: deleted ? null : user.email,
      role: user.role as PlayerDetail["account"]["role"],
      status: user.status as PlayerDetail["account"]["status"],
      blockedReason: deleted ? null : user.blockedReason,
      createdAt: user.createdAt.toISOString(),
      deletedAt: user.deletedAt?.toISOString() ?? null,
    };
    const warnings = deleted ? [] : await this.warningsOf(userId);
    const walletId = deleted ? undefined : await this.walletIdOf(userId);
    if (walletId === undefined) return { account, wallet: null, entryMode: null, openOrders: [], bids: [], warnings };

    const [head] = await this.db.select({ entryMode: wallets.entryMode }).from(wallets).where(eq(wallets.id, walletId));
    const orderRows = await this.db
      .select({ order: orders, ticker: sql<string>`${clubs.ticker}` })
      .from(orders)
      .innerJoin(clubs, eq(clubs.id, orders.clubId))
      .where(and(eq(orders.walletId, walletId), eq(orders.status, "open")))
      .orderBy(asc(orders.id));
    const bidRows = await this.db
      .select({ bid: ipoBids, ticker: sql<string>`${clubs.ticker}` })
      .from(ipoBids)
      .innerJoin(clubs, eq(clubs.id, ipoBids.clubId))
      .where(eq(ipoBids.walletId, walletId))
      .orderBy(asc(clubs.ticker));
    return {
      account,
      wallet: await this.walletService.view(walletId),
      entryMode: (head?.entryMode as PlayerDetail["entryMode"]) ?? null,
      openOrders: orderRows.map((r) => myOrderView(toOrderRecord(r.order, r.ticker))),
      bids: bidRows.map((r) => ({
        ticker: r.ticker,
        quantity: r.bid.quantity,
        maxPrice: r.bid.maxPrice,
        reserved: r.bid.reserved,
        status: r.bid.status as PlayerDetail["bids"][number]["status"],
      })),
      warnings,
    };
  }

  async entries(userId: string, query: EntriesQuery): Promise<EntriesResponse> {
    const [user] = await this.db.select({ status: users.status }).from(users).where(eq(users.id, userId));
    if (!user || user.status === "deleted") throw notFound();
    const walletId = await this.walletIdOf(userId);
    if (walletId === undefined) throw new DomainError("no_wallet", 409, ADMIN_ERROR_MESSAGES.no_wallet);
    return this.entriesService.list(walletId, query);
  }

  /**
   * As advertências por trapaça da temporada atual (T27): o caso e a data, sem a outra conta. Só se lê a da temporada,
   * então a temporada nova começa sem nenhuma; bot não tem conta de usuário e nunca tem advertência.
   */
  private async warningsOf(userId: string): Promise<PlayerDetail["warnings"]> {
    const season = await currentSeason(this.db);
    if (!season) return [];
    const rows = await this.db
      .select({ caseId: fraudWarnings.caseId, at: fraudWarnings.at })
      .from(fraudWarnings)
      .where(and(eq(fraudWarnings.userId, userId), eq(fraudWarnings.seasonId, season.id)))
      .orderBy(asc(fraudWarnings.at), asc(fraudWarnings.id));
    return rows.map((r) => ({ caseId: Number(r.caseId), at: r.at.toISOString() }));
  }

  /** A carteira do usuário na temporada atual. */
  private async walletIdOf(userId: string): Promise<number | undefined> {
    const season = await currentSeason(this.db);
    if (!season) return undefined;
    const [wallet] = await this.db
      .select({ id: wallets.id })
      .from(wallets)
      .where(and(eq(wallets.seasonId, season.id), eq(wallets.userId, userId)));
    return wallet?.id;
  }
}

function splitCursor(cursor: string): [string, string] {
  const [k, id] = cursor.split("\u0000");
  if (k === undefined || !id) throw new DomainError("invalid_input", 400, COMMON_ERROR_MESSAGES.invalid_input, ["cursor"]);
  return [k, id];
}
