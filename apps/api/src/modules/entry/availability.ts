import { and, count, eq } from "drizzle-orm";
import { ENTRY_AVAILABILITY_MESSAGES, type EntryAvailability } from "@futbolsa/contracts";
import { entryWindow, ENTRY_LEAGUE, type EntryWindow, type Match } from "@futbolsa/engine";
import type { Database, DrizzleTx } from "../../infra/db/index.js";
import { ipoResults, matches, seasonClubs, wallets } from "../../infra/db/schema/index.js";
import { currentSeason } from "../admin/current-season.js";
import { toEngineMatch } from "../admin/results/to-engine.js";

type Db = Database | DrizzleTx;

/** Quem entra: um jogador (com a situação da conta, que o guard já leu) ou um bot (F14). */
export type EntryOwner = { type: "user"; userId: string; status: string } | { type: "bot"; botId: number };

export interface EntryStatus {
  availability: EntryAvailability;
  message?: string;
  /** Só em `already_entered`, quando a carteira nasceu da entrada no meio. */
  mode?: "index" | "cash";
  /** A temporada atual, quando há. */
  seasonId?: number;
  /** O motivo do admin, em `market_suspended`. */
  reason?: string;
}

/** O que da temporada decide a disponibilidade, sem a janela dos jogos e sem a carteira. */
export interface SeasonGateInput {
  status: string;
  suspendedReason: string | null;
}

/**
 * A disponibilidade que vem só do estado da temporada (tabela "Disponibilidade e janela" do plano). `settled` diz se
 * o IPO já liquidou todos os clubes (só importa em `ipo_closed`). Devolve `null` quando a temporada deixa entrar.
 * Pura, para a transação de entrada usar a mesma regra com a linha que ela travou.
 */
export function seasonGate(season: SeasonGateInput, settled: boolean): EntryAvailability | null {
  switch (season.status) {
    case "preparing":
    case "ipo_open":
      return "not_open_yet";
    case "trading_ended":
    case "closed":
      return "window_closed";
    case "ipo_closed":
      if (!settled) return "settling";
      break;
  }
  // D2: o mercado todo suspenso bloqueia a entrada (clube suspenso sozinho não bloqueia)
  return season.suspendedReason !== null ? "market_suspended" : null;
}

/** A carteira do dono na temporada, ou `undefined`. */
export async function findWallet(db: Db, seasonId: number, owner: EntryOwner) {
  const [row] = await db
    .select({ id: wallets.id, entryMode: wallets.entryMode, enteredAt: wallets.enteredAt })
    .from(wallets)
    .where(
      and(eq(wallets.seasonId, seasonId), owner.type === "user" ? eq(wallets.userId, owner.userId) : eq(wallets.botId, owner.botId)),
    );
  return row;
}

/** Todos os clubes da temporada já têm resultado de IPO (a liquidação acabou). */
export async function ipoSettled(db: Db, seasonId: number): Promise<boolean> {
  const [[listed], [settled]] = await Promise.all([
    db.select({ n: count() }).from(seasonClubs).where(eq(seasonClubs.seasonId, seasonId)),
    db.select({ n: count() }).from(ipoResults).where(eq(ipoResults.seasonId, seasonId)),
  ]);
  return listed!.n > 0 && settled!.n >= listed!.n;
}

/** Os jogos da Série A da temporada, no formato do motor (o ticker não importa aqui: só os horários). */
export async function loadSerieAMatches(db: Db, seasonId: number): Promise<Match[]> {
  const rows = await db
    .select()
    .from(matches)
    .where(and(eq(matches.seasonId, seasonId), eq(matches.competition, ENTRY_LEAGUE)));
  return rows.map((r) => toEngineMatch(r, (id) => String(id)));
}

/** A janela da entrada a partir dos jogos da Série A (P4): sem coluna nova, calculada a cada chamada. */
export async function loadEntryWindow(db: Db, seasonId: number, now: Date): Promise<EntryWindow> {
  return entryWindow(await loadSerieAMatches(db, seasonId), now.getTime());
}

export function statusOf(availability: EntryAvailability, extra: Partial<EntryStatus> = {}): EntryStatus {
  if (availability === "open") return { availability, ...extra };
  const base = ENTRY_AVAILABILITY_MESSAGES[availability];
  const message = availability === "market_suspended" && extra.reason ? `${base} Motivo: ${extra.reason}` : base;
  return { availability, message, ...extra };
}

/**
 * A disponibilidade da entrada agora, sem trava nenhuma (leitura comum): a prévia e o `needsEntry` usam. A transação
 * de entrada refaz as mesmas conferências depois de travar a temporada e os clubes.
 */
export async function readAvailability(db: Db, owner: EntryOwner, now: Date): Promise<EntryStatus> {
  const season = await currentSeason(db);
  if (!season) return statusOf("not_open_yet");
  const existing = await findWallet(db, season.id, owner);
  if (existing) {
    const mode = existing.entryMode === "index" || existing.entryMode === "cash" ? existing.entryMode : undefined;
    return statusOf("already_entered", { seasonId: season.id, mode });
  }
  const settled = season.status === "ipo_closed" ? await ipoSettled(db, season.id) : true;
  const gate = seasonGate(season, settled);
  if (gate === "market_suspended") {
    return statusOf(gate, { seasonId: season.id, reason: season.suspendedReason ?? undefined });
  }
  if (gate) return statusOf(gate, { seasonId: season.id });
  const window = await loadEntryWindow(db, season.id, now);
  if (window.state === "closed") return statusOf("window_closed", { seasonId: season.id });
  return statusOf("open", { seasonId: season.id });
}
