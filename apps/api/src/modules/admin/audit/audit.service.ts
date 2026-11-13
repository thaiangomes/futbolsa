import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import {
  COMMON_ERROR_MESSAGES,
  type AuditQuery,
  type AuditResponse,
  type TradeParty,
} from "@futbolsa/contracts";
import { DB, type Database } from "../../../infra/db/index.js";
import { bots, users, wallets } from "../../../infra/db/schema/index.js";
import { DomainError } from "../../../infra/http/index.js";
import { auditTrades } from "../../market/audit/audit-trades.js";
import { currentSeason } from "../current-season.js";

const PAGE = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (field: string) => new DomainError("invalid_input", 400, COMMON_ERROR_MESSAGES.invalid_input, [field]);

/**
 * Auditoria de negócios (Admin, critério 34; T7 da F14): comprador e vendedor de cada negócio, com filtro por jogador,
 * par de contas, clube e período. O `market` devolve as carteiras (`auditTrades`); aqui os donos viram apelido, bot
 * marcado, "casa" ou "conta excluída", em lote. Contas se informam por id de usuário, `bot:<id>` ou `house`.
 */
@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async list(query: AuditQuery): Promise<AuditResponse> {
    const season = query.season ? { id: query.season } : await currentSeason(this.db);
    if (!season) return { trades: [], nextCursor: null };

    const walletFilter = query.player ? await this.walletOfAccount(season.id, query.player, "player") : undefined;
    let pair: [number, number] | undefined;
    if (query.pair) {
      const [a, b] = query.pair.split(",").map((p) => p.trim());
      const [wa, wb] = [await this.walletOfAccount(season.id, a!, "pair"), await this.walletOfAccount(season.id, b!, "pair")];
      // conta sem carteira na temporada não tem negócio: nenhum resultado
      if (wa === null || wb === null) return { trades: [], nextCursor: null };
      pair = [wa, wb];
    }
    if (walletFilter === null) return { trades: [], nextCursor: null };

    const rows = await auditTrades(this.db, {
      seasonId: season.id,
      ...(walletFilter !== undefined ? { wallet: walletFilter } : {}),
      ...(pair ? { pair } : {}),
      ...(query.club ? { ticker: query.club } : {}),
      ...(query.from ? { from: new Date(query.from) } : {}),
      ...(query.to ? { to: new Date(query.to) } : {}),
      ...(query.cursor ? { after: parseCursor(query.cursor) } : {}),
      limit: PAGE + 1,
    });
    const page = rows.slice(0, PAGE);
    const parties = await this.parties([...new Set(page.flatMap((r) => [r.buyerWalletId, r.sellerWalletId]))]);
    const last = page[page.length - 1];
    return {
      trades: page.map((r) => ({
        id: r.id,
        at: r.at.toISOString(),
        ticker: r.ticker,
        quantity: r.quantity,
        price: r.price,
        value: r.quantity * r.price,
        inAuction: r.inAuction,
        buyer: parties.get(r.buyerWalletId)!,
        seller: parties.get(r.sellerWalletId)!,
      })),
      nextCursor: rows.length > PAGE && last ? `${last.at.toISOString()}|${last.id}` : null,
    };
  }

  /** A carteira da conta na temporada; `null` se a conta não tem. Id malformado é erro de entrada. */
  private async walletOfAccount(seasonId: number, account: string, field: string): Promise<number | null> {
    if (account === "house") {
      const [w] = await this.db.select({ id: wallets.id }).from(wallets).where(and(eq(wallets.seasonId, seasonId), eq(wallets.ownerType, "treasury")));
      return w?.id ?? null;
    }
    if (account.startsWith("bot:")) {
      const botId = Number(account.slice(4));
      if (!Number.isInteger(botId) || botId < 1) throw invalid(field);
      const [w] = await this.db.select({ id: wallets.id }).from(wallets).where(and(eq(wallets.seasonId, seasonId), eq(wallets.botId, botId)));
      return w?.id ?? null;
    }
    if (!UUID.test(account)) throw invalid(field);
    const [w] = await this.db.select({ id: wallets.id }).from(wallets).where(and(eq(wallets.seasonId, seasonId), eq(wallets.userId, account)));
    return w?.id ?? null;
  }

  /** Os rótulos dos donos das carteiras, em lote. */
  private async parties(walletIds: number[]): Promise<Map<number, TradeParty>> {
    const out = new Map<number, TradeParty>();
    if (walletIds.length === 0) return out;
    const rows = await this.db
      .select({
        id: wallets.id,
        ownerType: wallets.ownerType,
        userId: wallets.userId,
        botId: wallets.botId,
        nickname: users.nickname,
        status: users.status,
      })
      .from(wallets)
      .leftJoin(users, eq(users.id, wallets.userId))
      .where(inArray(wallets.id, walletIds));
    const botIds = rows.flatMap((r) => (r.botId === null ? [] : [r.botId]));
    const profiles = new Map<number, string>();
    if (botIds.length > 0) {
      for (const b of await this.db.select({ id: bots.id, profile: bots.profile }).from(bots).where(inArray(bots.id, botIds))) profiles.set(b.id, b.profile);
    }
    for (const r of rows) {
      if (r.ownerType === "treasury") out.set(r.id, { kind: "house", id: null, label: "casa" });
      else if (r.ownerType === "bot") out.set(r.id, { kind: "bot", id: `bot:${r.botId}`, label: `bot ${profiles.get(r.botId!)} #${r.botId}` });
      else if (r.status === "deleted" || r.nickname === null) out.set(r.id, { kind: "deleted", id: r.userId, label: "conta excluída" });
      else out.set(r.id, { kind: "player", id: r.userId, label: r.nickname });
    }
    return out;
  }
}

function parseCursor(cursor: string): { at: Date; id: number } {
  const [iso, id] = cursor.split("|");
  const at = new Date(iso ?? "");
  const n = Number(id);
  if (Number.isNaN(at.getTime()) || !Number.isInteger(n) || n < 0) throw invalid("cursor");
  return { at, id: n };
}
