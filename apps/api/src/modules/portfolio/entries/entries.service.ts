import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { COMMON_ERROR_MESSAGES, type EntriesQuery, type EntriesResponse } from "@futbolsa/contracts";
import { DB, type Database } from "../../../infra/db/index.js";
import { wallets } from "../../../infra/db/schema/index.js";
import { DomainError } from "../../../infra/http/index.js";
import { currentSeason } from "../../admin/current-season.js";
import { WALLET_NOT_FOUND } from "../wallet/wallet.service.js";
import { type EntryRow, entryItemOf, kindsOfGroup } from "./entry-view.js";

/** `"2027-04-06T18:00:00.000Z|123"`: a posição da última linha da página (horário e id). */
function encodeCursor(row: { at: Date; id: number }): string {
  return `${row.at.toISOString()}|${row.id}`;
}

function decodeCursor(cursor: string): { at: Date; id: number } {
  const [iso, id] = cursor.split("|");
  const at = new Date(iso ?? "");
  const n = Number(id);
  if (Number.isNaN(at.getTime()) || !Number.isInteger(n) || n < 0) throw new DomainError("invalid_input", 400, COMMON_ERROR_MESSAGES.invalid_input, ["before"]);
  return { at, id: n };
}

/**
 * O extrato de uma carteira, do mais novo para o mais antigo, paginado por cursor (horário e id). Mostra as linhas que
 * mexem no caixa ou nas ações (P4: as que só prendem e soltam reserva ficam de fora, e a soma do caixa continua igual).
 * Nunca traz a contraparte: nenhuma coluna de outra carteira entra na consulta. O mesmo serviço serve ao extrato do
 * admin (F14), que recebe a carteira por parâmetro.
 */
@Injectable()
export class EntriesService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async listForUser(userId: string, query: EntriesQuery): Promise<EntriesResponse> {
    const season = await currentSeason(this.db);
    if (!season) throw new DomainError(WALLET_NOT_FOUND, 404, COMMON_ERROR_MESSAGES.not_found);
    const [wallet] = await this.db.select({ id: wallets.id }).from(wallets).where(and(eq(wallets.seasonId, season.id), eq(wallets.userId, userId)));
    if (!wallet) throw new DomainError(WALLET_NOT_FOUND, 404, "Você ainda não entrou na temporada.");
    return this.list(wallet.id, query);
  }

  async list(walletId: number, query: EntriesQuery): Promise<EntriesResponse> {
    const limit = query.limit;
    const filters = [sql`e.wallet_id = ${walletId}`, sql`(e.cash_delta <> 0 or e.shares_delta <> 0 or e.kind = 'trade_annulled')`];
    if (query.club) filters.push(sql`c.ticker = ${query.club}`);
    if (query.kind) {
      const kinds = kindsOfGroup(query.kind);
      filters.push(sql`e.kind in (${sql.join(kinds.map((k) => sql`${k}`), sql`, `)})`);
    }
    if (query.before) {
      const cursor = decodeCursor(query.before);
      filters.push(sql`(e.at, e.id) < (${cursor.at.toISOString()}::timestamptz, ${cursor.id})`);
    }
    const result = await this.db.execute(sql`
      select e.id::bigint as id, e.at, e.kind, c.ticker, c.name as club_name, c.badge_abbr, c.color_primary, c.color_secondary,
             e.cash_delta::bigint as cash_delta, e.shares_delta, e.price::bigint as price, e.realized::bigint as realized,
             e.cash_after::bigint as cash_after, e.reason,
             pe.reason as event_reason, pe.per_share::bigint as per_share, h.shares as holding_shares,
             t.in_auction, (ta.trade_id is not null and e.kind = 'trade') as annulled
      from futbolsa.wallet_entries e
      left join futbolsa.clubs c on c.id = e.club_id
      left join futbolsa.payout_credits pc on pc.entry_id = e.id
      left join futbolsa.payout_events pe on pe.id = pc.event_id
      left join futbolsa.payout_holdings h on h.event_id = pe.id and h.wallet_id = e.wallet_id
      left join futbolsa.trades t on e.ref_type = 'trade' and t.id = (case when e.ref_type = 'trade' then e.ref_id::bigint end)
      left join futbolsa.trade_annulments ta on ta.trade_id = t.id
      where ${sql.join(filters, sql` and `)}
      order by e.at desc, e.id desc
      limit ${limit + 1}`);
    const rows = result.rows.map((r) => ({
      ...r,
      id: Number(r.id),
      at: new Date(r.at as string | Date),
      cash_delta: Number(r.cash_delta),
      price: r.price === null ? null : Number(r.price),
      realized: r.realized === null ? null : Number(r.realized),
      cash_after: Number(r.cash_after),
      per_share: r.per_share === null ? null : Number(r.per_share),
      holding_shares: r.holding_shares === null ? null : Number(r.holding_shares),
    })) as unknown as EntryRow[];
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { items: page.map(entryItemOf), nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
  }
}
