import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  ADMIN_ERROR_MESSAGES,
  BOT_PROFILE_NAMES,
  type BotProfileName,
  type BotsView,
  type PatchBotsBody,
  type PatchBotsResponse,
} from "@futbolsa/contracts";
import { Clock } from "../../../infra/clock/index.js";
import { DB, type Database, lockClubs, lockSeason, lockWallets, type Tx, withTransaction } from "../../../infra/db/index.js";
import { bots, wallets } from "../../../infra/db/schema/index.js";
import { DomainError } from "../../../infra/http/index.js";
import { readAvailability } from "../../entry/availability.js";
import { EntryService } from "../../entry/enter.service.js";
import { CancelService } from "../../market/orders/cancel.service.js";
import { openOrderTickers } from "../../market/orders/closure-hook.js";
import { PortfolioLedger } from "../../portfolio/portfolio.module.js";
import { SEASON_START_CASH } from "../../accounts/season-start.js";
import { equityAtWallets } from "../../rankings/equity-at.js";
import { currentSeason } from "../current-season.js";
import { AdminLogService } from "../log/index.js";

const closed = () => new DomainError("bot_entry_closed", 409, ADMIN_ERROR_MESSAGES.bot_entry_closed);

interface ProfileChange {
  profile: BotProfileName;
  before: number;
  after: number;
  turnedOn: number[];
  turnedOff: number[];
  created: number[];
  /** Bots ligados que ainda precisam da carteira índice (a entrada tem a própria transação). */
  needsEntry: number[];
}

/**
 * Bots ao vivo: quantos ativos por perfil (Admin, critérios 29 e 30; T10 da F14). Quem desliga e quem liga (proposta 9):
 * desliga primeiro os de id maior; para ligar, religa os desligados de id menor e só depois cria bots novos. Assim voltar de
 * 10 para 25 religa os mesmos 15 de antes, com as carteiras que eles mantiveram.
 *
 * - **Desligar** (uma transação por perfil): trava as linhas dos bots do perfil em ordem de id, a temporada
 *   (compartilhada), os clubes das ordens abertas deles e as carteiras; cancela todas as ordens (`bot_off`) e grava
 *   `active = false`. A carteira fica e recebe dividendos.
 * - **Ligar**: com a temporada em preparação só liga; com o IPO aberto, abre a carteira de R$ 100.000,00; entre o
 *   fechamento do IPO e o fim da janela de entrada, o bot sem carteira entra pela carteira índice (serviço da F11,
 *   numa transação própria, depois do `COMMIT`); depois da janela, bot sem carteira é recusado (`bot_entry_closed`).
 *   Religar quem já tem carteira vale sempre.
 * - Dois admins mudando o mesmo perfil ao mesmo tempo: a contagem trava as linhas do perfil antes de decidir.
 */
@Injectable()
export class BotsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly clock: Clock,
    private readonly log: AdminLogService,
    private readonly ledger: PortfolioLedger,
    private readonly cancels: CancelService,
    private readonly entry: EntryService,
  ) {}

  /** `GET /admin/bots`: por perfil, quantos ativos, quantos desligados e a lista com o patrimônio de cada carteira. */
  async view(): Promise<BotsView> {
    const season = await currentSeason(this.db);
    return withTransaction(
      this.db,
      async (tx) => {
        const rows = await tx.db
          .select({ id: bots.id, profile: bots.profile, active: bots.active, walletId: wallets.id })
          .from(bots)
          .leftJoin(wallets, and(eq(wallets.botId, bots.id), eq(wallets.seasonId, season?.id ?? -1)))
          .orderBy(asc(bots.id));
        const walletIds = rows.flatMap((r) => (r.walletId === null ? [] : [r.walletId]));
        const equity = season && walletIds.length ? await equityAtWallets(tx, season.id, this.clock.now(), walletIds) : new Map();
        return {
          profiles: BOT_PROFILE_NAMES.map((profile) => {
            const mine = rows.filter((r) => r.profile === profile);
            return {
              profile,
              active: mine.filter((r) => r.active).length,
              inactive: mine.filter((r) => !r.active).length,
              bots: mine.map((r) => ({
                id: r.id,
                active: r.active,
                hasWallet: r.walletId !== null,
                equity: r.walletId === null ? null : (equity.get(r.walletId)?.equity ?? null),
              })),
            };
          }),
          botsInRankings: season?.botsInRankings ?? false,
        };
      },
      { isolationLevel: "repeatable read", readOnly: true },
    );
  }

  async update(adminId: string, body: PatchBotsBody): Promise<PatchBotsResponse> {
    const changes: ProfileChange[] = [];
    // uma transação por perfil, em ordem fixa: duas mudanças ao mesmo tempo esperam uma a outra, nunca em círculo
    for (const profile of BOT_PROFILE_NAMES) {
      const target = body.counts[profile];
      if (target === undefined) continue;
      changes.push(await withTransaction(this.db, (tx) => this.changeProfile(tx, adminId, profile, target, body.reason)));
    }
    // a carteira índice tem a própria transação (trava todos os clubes): depois do COMMIT de cada perfil. Cada falha é
    // coletada, sem parar os outros bots; os que não entraram por a janela ter fechado voltam a ficar desligados, com registro.
    const notEntered: Array<{ profile: BotProfileName; botId: number }> = [];
    for (const change of changes) {
      for (const botId of change.needsEntry) {
        try {
          await this.entry.enterBot(botId);
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code === "entry_window_closed") notEntered.push({ profile: change.profile, botId });
          // fila cheia, IPO ainda liquidando ou mercado suspenso: o bot fica ligado e a tarefa dos bots entra depois
          else if (code !== "entry_busy" && code !== "entry_not_ready" && code !== "market_suspended" && code !== "entry_not_open") throw error;
        }
      }
    }
    if (notEntered.length > 0) {
      await withTransaction(this.db, async (tx) => {
        const ids = notEntered.map((n) => n.botId).sort((x, y) => x - y);
        await tx.db.select({ id: bots.id }).from(bots).where(inArray(bots.id, ids)).orderBy(asc(bots.id)).for("no key update");
        await tx.db.update(bots).set({ active: false }).where(inArray(bots.id, ids));
        await this.log.record(tx, {
          actorId: adminId,
          action: "bots.update",
          targetType: "bots",
          targetId: "janela_fechada",
          before: { turnedOn: ids },
          after: { turnedOff: ids, why: "bot_entry_closed" },
        });
      });
      throw closed();
    }
    return {
      turnedOn: changes.flatMap((c) => c.turnedOn).sort((a, b) => a - b),
      turnedOff: changes.flatMap((c) => c.turnedOff).sort((a, b) => a - b),
      created: changes.flatMap((c) => c.created).sort((a, b) => a - b),
    };
  }

  private async changeProfile(tx: Tx, adminId: string, profile: BotProfileName, target: number, reason?: string): Promise<ProfileChange> {
    const now = this.clock.now();
    // a trava do perfil, antes de ler: sem ela, dois pedidos de criação ao mesmo tempo não se veem (as linhas novas ainda não existem)
    await tx.db.execute(sql`select pg_advisory_xact_lock(hashtext(${`bots:${profile}`}))`);
    // as linhas do perfil, em ordem de id (NO KEY UPDATE: a carteira do bot aponta para elas)
    const rows = await tx.db.select().from(bots).where(eq(bots.profile, profile)).orderBy(asc(bots.id)).for("no key update");
    const active = rows.filter((r) => r.active);
    const inactive = rows.filter((r) => !r.active);
    const change: ProfileChange = { profile, before: active.length, after: target, turnedOn: [], turnedOff: [], created: [], needsEntry: [] };

    const season = await currentSeason(tx.db);
    const held = season ? await lockSeason(tx, season.id, "share") : undefined;
    // a temporada que encerrou enquanto a trava era esperada conta como nenhuma: ligar e desligar não mexe nela (F15, T7)
    const locked = held && held.status !== "closed" ? held : undefined;

    if (target < active.length) {
      const off = active.slice(target);
      await this.turnOff(tx, locked?.id, off.map((b) => b.id), now);
      change.turnedOff = off.map((b) => b.id);
    } else if (target > active.length) {
      const need = target - active.length;
      const revive = inactive.slice(0, need);
      const toCreate = need - revive.length;
      const createdIds: number[] = [];
      if (toCreate > 0) {
        const inserted = await tx.db
          .insert(bots)
          .values(Array.from({ length: toCreate }, () => ({ profile, active: false })))
          .returning({ id: bots.id });
        createdIds.push(...inserted.map((r) => r.id).sort((a, b) => a - b));
      }
      const turnOn = [...revive.map((b) => b.id), ...createdIds];
      for (const botId of turnOn) await this.turnOn(tx, locked, botId, change, now);
      change.turnedOn = revive.map((b) => b.id);
      change.created = createdIds;
    }

    if (change.turnedOn.length || change.turnedOff.length || change.created.length) {
      await this.log.record(tx, {
        actorId: adminId,
        action: "bots.update",
        targetType: "bots",
        targetId: profile,
        reason,
        before: { profile, active: change.before },
        after: { profile, active: change.after, turnedOn: change.turnedOn, turnedOff: change.turnedOff, created: change.created },
      });
    }
    return change;
  }

  /** Desliga os bots dados: cancela as ordens (`bot_off`) com os clubes e as carteiras travados na ordem do jogo. */
  private async turnOff(tx: Tx, seasonId: number | undefined, botIds: number[], now: Date): Promise<void> {
    if (seasonId !== undefined) {
      const owned = await tx.db
        .select({ id: wallets.id })
        .from(wallets)
        .where(and(eq(wallets.seasonId, seasonId), inArray(wallets.botId, botIds)))
        .orderBy(asc(wallets.id));
      if (owned.length > 0) {
        const tickers = new Set<string>();
        for (const w of owned) for (const t of await openOrderTickers(tx, w.id)) tickers.add(t);
        await lockClubs(tx, seasonId, [...tickers]);
        await lockWallets(tx, owned.map((w) => w.id));
        for (const w of owned) await this.cancels.cancelOrders(tx, w.id, {}, "bot_off", now);
      }
    }
    await tx.db.update(bots).set({ active: false }).where(inArray(bots.id, botIds));
  }

  /** Liga um bot, com a carteira conforme a fase da temporada. */
  private async turnOn(tx: Tx, season: { id: number; status: string } | undefined, botId: number, change: ProfileChange, now: Date): Promise<void> {
    if (season) {
      const [own] = await tx.db.select({ id: wallets.id }).from(wallets).where(and(eq(wallets.seasonId, season.id), eq(wallets.botId, botId)));
      if (!own) {
        if (season.status === "ipo_open") {
          await this.ledger.openWallet(tx, { seasonId: season.id, owner: { type: "bot", botId }, at: now, entryMode: "ipo", initialCash: SEASON_START_CASH });
        } else if (season.status === "ipo_closed" || season.status === "trading") {
          const availability = await readAvailability(tx.db, { type: "bot", botId }, now);
          if (availability.availability === "window_closed") throw closed();
          // `open`: entra agora; `settling` e `market_suspended`: a entrada recusa por enquanto e a tarefa dos bots entra depois
          change.needsEntry.push(botId);
        } else if (season.status !== "preparing") {
          throw closed();
        }
      }
    }
    await tx.db.update(bots).set({ active: true }).where(eq(bots.id, botId));
  }
}
