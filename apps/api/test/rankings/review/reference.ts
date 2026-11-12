import { sql } from "drizzle-orm";
import type { Database } from "../../../src/infra/db/client.js";

/**
 * A referência lenta da revisão (T10 do Plano dos rankings): o patrimônio de uma carteira num instante T somando o
 * extrato **desde o começo** (nada de "estado de hoje menos o que veio depois"), o último negócio até T pela tabela de
 * negócios e o a receber evento por evento, como a especificação diz. Lê as tabelas cruas uma vez e calcula em memória,
 * sem nenhum código de `src/` (a regra escrita de novo).
 */
interface Entry {
  at: number;
  kind: string;
  clubId: number | null;
  cash: number;
  shares: number;
}
interface Event {
  id: number;
  clubId: number;
  key: string;
  status: string;
  perShare: number;
  closedAt: number;
}

export interface History {
  wallets: Map<number, { enteredAt: number }>;
  entries: Map<number, Entry[]>;
  trades: Map<number, Array<{ at: number; id: number; price: number }>>;
  fallbackPrice: Map<number, number>;
  tradingEndedAt: number | null;
  /** As versões de cada chave (clube, evento). */
  keys: Event[][];
  holdings: Map<number, Map<number, number>>;
  /** Créditos por carteira: evento, valor com sinal e o horário da linha do extrato. */
  credits: Map<number, Array<{ eventId: number; amount: number; at: number }>>;
}

const ms = (v: unknown) => new Date(v as string).getTime();

export async function loadHistory(db: Database, seasonId: number): Promise<History> {
  const wallets = new Map<number, { enteredAt: number }>();
  for (const r of (await db.execute(sql`select id, entered_at from futbolsa.wallets where season_id = ${seasonId}`)).rows) {
    wallets.set(Number(r.id), { enteredAt: ms(r.entered_at) });
  }
  const entries = new Map<number, Entry[]>();
  for (const r of (
    await db.execute(sql`
      select e.wallet_id, e.at, e.kind, e.club_id, e.cash_delta, e.shares_delta
      from futbolsa.wallet_entries e join futbolsa.wallets w on w.id = e.wallet_id where w.season_id = ${seasonId}`)
  ).rows) {
    const list = entries.get(Number(r.wallet_id)) ?? [];
    list.push({ at: ms(r.at), kind: String(r.kind), clubId: r.club_id === null ? null : Number(r.club_id), cash: Number(r.cash_delta), shares: Number(r.shares_delta) });
    entries.set(Number(r.wallet_id), list);
  }
  const trades = new Map<number, Array<{ at: number; id: number; price: number }>>();
  for (const r of (await db.execute(sql`select id, club_id, at, price from futbolsa.trades where season_id = ${seasonId}`)).rows) {
    const list = trades.get(Number(r.club_id)) ?? [];
    list.push({ at: ms(r.at), id: Number(r.id), price: Number(r.price) });
    trades.set(Number(r.club_id), list);
  }
  const fallbackPrice = new Map<number, number>();
  for (const r of (await db.execute(sql`select club_id, coalesce(ipo_price, last_price) as p from futbolsa.season_clubs where season_id = ${seasonId}`)).rows) {
    fallbackPrice.set(Number(r.club_id), Number(r.p));
  }
  const [season] = (await db.execute(sql`select trading_ended_at from futbolsa.seasons where id = ${seasonId}`)).rows;
  const byKey = new Map<string, Event[]>();
  for (const r of (await db.execute(sql`select id, club_id, event_key, status, per_share, closed_at from futbolsa.payout_events where season_id = ${seasonId}`)).rows) {
    const e = { id: Number(r.id), clubId: Number(r.club_id), key: String(r.event_key), status: String(r.status), perShare: Number(r.per_share), closedAt: ms(r.closed_at) };
    const k = `${e.clubId}|${e.key}`;
    byKey.set(k, [...(byKey.get(k) ?? []), e]);
  }
  const holdings = new Map<number, Map<number, number>>();
  for (const r of (
    await db.execute(sql`select h.event_id, h.wallet_id, h.shares from futbolsa.payout_holdings h join futbolsa.payout_events e on e.id = h.event_id where e.season_id = ${seasonId}`)
  ).rows) {
    const m = holdings.get(Number(r.event_id)) ?? new Map<number, number>();
    m.set(Number(r.wallet_id), Number(r.shares));
    holdings.set(Number(r.event_id), m);
  }
  const credits = new Map<number, Array<{ eventId: number; amount: number; at: number }>>();
  for (const r of (
    await db.execute(sql`
      select c.event_id, c.wallet_id, c.amount, en.at from futbolsa.payout_credits c
      join futbolsa.payout_events e on e.id = c.event_id join futbolsa.wallet_entries en on en.id = c.entry_id
      where e.season_id = ${seasonId}`)
  ).rows) {
    const list = credits.get(Number(r.wallet_id)) ?? [];
    list.push({ eventId: Number(r.event_id), amount: Number(r.amount), at: ms(r.at) });
    credits.set(Number(r.wallet_id), list);
  }
  return {
    wallets,
    entries,
    trades,
    fallbackPrice,
    tradingEndedAt: season?.trading_ended_at ? ms(season.trading_ended_at) : null,
    keys: [...byKey.values()],
    holdings,
    credits,
  };
}

function priceAt(h: History, clubId: number, at: number): number {
  let best: { at: number; id: number; price: number } | undefined;
  for (const t of h.trades.get(clubId) ?? []) {
    if (t.at > at) continue;
    if (!best || t.at > best.at || (t.at === best.at && t.id > best.id)) best = t;
  }
  return best ? best.price : h.fallbackPrice.get(clubId)!;
}

export interface SlowEquity {
  cash: number;
  shares: Map<number, number>;
  receivable: number;
  equity: number;
}

/** O patrimônio da carteira em `at` pela soma do extrato desde o começo; `undefined` se a carteira ainda não existia. */
export function slowEquity(h: History, walletId: number, at: number): SlowEquity | undefined {
  const w = h.wallets.get(walletId);
  if (!w || w.enteredAt > at) return undefined;
  let cash = 0;
  const shares = new Map<number, number>();
  for (const e of h.entries.get(walletId) ?? []) {
    // a linha `season_close` zera a carteira no encerramento e nunca conta para o patrimônio de antes
    if (e.at > at || e.kind === "season_close") continue;
    cash += e.cash;
    if (e.clubId !== null) shares.set(e.clubId, (shares.get(e.clubId) ?? 0) + e.shares);
  }
  const buybackClosed = h.tradingEndedAt !== null && h.tradingEndedAt <= at;
  let stocks = 0;
  if (!buybackClosed) for (const [clubId, n] of shares) if (n !== 0) stocks += n * priceAt(h, clubId, at);

  // a receber: por chave, a versão vigente fechada até `at`, menos o creditado por **todas** as versões até `at`
  let receivable = 0;
  const mine = h.credits.get(walletId) ?? [];
  for (const versions of h.keys) {
    const current = versions.filter((v) => v.status !== "superseded");
    if (current.length > 1) throw new Error(`duas versões vigentes na chave ${versions[0]!.key}`);
    const cur = current[0];
    if (!cur || cur.closedAt > at) continue;
    const due = (h.holdings.get(cur.id)?.get(walletId) ?? 0) * cur.perShare;
    const ids = new Set(versions.map((v) => v.id));
    const credited = mine.filter((c) => ids.has(c.eventId) && c.at <= at).reduce((s, c) => s + c.amount, 0);
    receivable += due - credited;
  }
  return { cash, shares, receivable, equity: cash + stocks + receivable };
}
