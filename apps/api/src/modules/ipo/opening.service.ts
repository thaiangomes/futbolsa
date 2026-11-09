import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import type { IpoBlocker } from "@futbolsa/contracts";
import { ipoDates } from "@futbolsa/engine";
import { DB, type Database, type DrizzleTx, lockSeason, type SeasonRow, type Tx, withTransaction } from "../../infra/db/index.js";
import { bots, clubs, matches, seasonClubs, seasonRules, seasons, wallets } from "../../infra/db/schema/index.js";
import { CUP_COMPETITIONS } from "../../infra/db/schema/values.js";
import { DomainError } from "../../infra/http/index.js";
import { AccountsService, SEASON_START_CASH } from "../accounts/index.js";
import { currentSeason } from "../admin/current-season.js";
import { SeasonValuesService } from "../dividends/season-values/season-values.service.js";
import { PortfolioLedger } from "../portfolio/index.js";
import { clubsListValid, ipoBands, type ListedClub } from "./bands.js";
import { IpoEvents } from "./events.js";

/** O que uma passada da tarefa de abertura fez. */
export type IpoOpenResult =
  /** Nada a fazer: sem temporada, já aberta (ou depois) ou antes do horário de abertura. */
  | { status: "idle" }
  /** Passou do horário, mas falta algo: não abriu, e a visão geral do admin mostra os motivos. */
  | { status: "blocked"; seasonId: number; blockers: IpoBlocker[] }
  /** Abriu agora: faixas gravadas, valores travados e `credited` contas com R$ 100.000,00. */
  | { status: "opened"; seasonId: number; credited: number };

type Executor = Database | DrizzleTx;

/** Até quanto depois do horário previsto uma abertura ainda conta como no horário (a tarefa roda a cada minuto). */
const OPENING_TOLERANCE_MS = 5 * 60_000;

/**
 * Abre as ofertas do IPO na data (IPO por bookbuilding, critério 1; Admin, critério 19), sem ação do
 * admin: a tarefa de cada minuto (A7) chama `openIfDue` com o relógio da API. Numa transação só, com
 * a temporada travada em modo exclusivo:
 * 1. segue só com `preparing` e `agora ≥ abertura` (pelo primeiro jogo);
 * 2. confere as condições (oferta, primeiro jogo, clubes, tabelas das copas, antes do fechamento); faltando
 *    uma, não abre e devolve os motivos (proposta 6);
 * 3. calcula e grava a faixa de cada clube, fixa até o fechamento (proposta 1);
 * 4. trava os valores da temporada e grava as datas do IPO;
 * 5. abre a tesouraria (sem caixa) e as carteiras dos bots ativos com R$ 100.000,00 (proposta 5);
 * 6. credita R$ 100.000,00 a toda conta de jogador (`creditSeasonStart`, Conta e login 12, 17 e 18);
 * 7. passa a temporada para `ipo_open`.
 * Repetível: a segunda passada vê `ipo_open` e não faz nada.
 */
@Injectable()
export class IpoOpeningService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly accounts: AccountsService,
    private readonly ledger: PortfolioLedger,
    private readonly values: SeasonValuesService,
    private readonly events: IpoEvents,
  ) {}

  async openIfDue(now: Date): Promise<IpoOpenResult> {
    const candidate = await currentSeason(this.db);
    if (!candidate) return { status: "idle" };
    return withTransaction(this.db, async (tx) => {
      // A trava exclusiva espera os cadastros em andamento (que travam em modo compartilhado) e outra
      // abertura ao mesmo tempo; o estado lido depois dela é o que vale.
      const season = await lockSeason(tx, candidate.id, "update");
      if (!this.isDue(season, now)) return { status: "idle" } as const;

      const listed = await this.listedClubs(tx.db, season.id);
      const blockers = await this.conditions(tx.db, season, listed, now);
      if (blockers.length > 0) return { status: "blocked", seasonId: season.id, blockers } as const;

      const dates = ipoDates(season.firstKickoff!.getTime());
      await this.writeBands(tx, season.id, listed, dates.closesAt);
      await this.values.lockSeasonValues(tx, season.id, now);
      await this.openHouseWallets(tx, season.id, now);
      const credited = await this.accounts.creditSeasonStart(tx, season.id, now);
      const [opened] = await tx.db
        .update(seasons)
        .set({
          status: "ipo_open",
          // Abertura no horário (a tarefa roda a cada minuto, então um pequeno atraso é normal): o horário
          // previsto. Abertura atrasada porque faltava algo: o horário real, para a tela e o `GET /me` não
          // mostrarem uma abertura no passado que não aconteceu (decisão do Thaian em 2026-11-09).
          ipoOpensAt: new Date(now.getTime() - dates.opensAt > OPENING_TOLERANCE_MS ? now.getTime() : dates.opensAt),
          ipoClosesAt: new Date(dates.closesAt),
          tradingOpensAt: new Date(dates.tradingOpensAt),
        })
        .where(eq(seasons.id, season.id))
        .returning();
      // Depois do COMMIT, todo mundo que está com o site aberto vê o IPO abrir sem recarregar.
      this.events.seasonStatus(tx, opened!);
      return { status: "opened", seasonId: season.id, credited } as const;
    });
  }

  /**
   * Os motivos de o IPO não abrir, sem abrir nada nem travar (para a visão geral do admin). Vazia sem
   * temporada, fora de `preparing` ou antes do horário de abertura: aí não há nada a mostrar.
   */
  async blockers(now: Date, executor: Executor = this.db): Promise<IpoBlocker[]> {
    const season = await currentSeason(executor);
    if (!season || !this.isDue(season, now)) return [];
    return this.conditions(executor, season, await this.listedClubs(executor, season.id), now);
  }

  /** `preparing` e já no horário de abertura, 14 dias antes do primeiro jogo. */
  private isDue(season: SeasonRow, now: Date): boolean {
    if (season.status !== "preparing" || !season.firstKickoff) return false;
    return now.getTime() >= ipoDates(season.firstKickoff.getTime()).opensAt;
  }

  /** O que falta para abrir, na ordem da tela; vazia quando pode abrir. */
  private async conditions(executor: Executor, season: SeasonRow, listed: readonly ListedClub[], now: Date): Promise<IpoBlocker[]> {
    const blockers: IpoBlocker[] = [];
    if (season.offerSize === null) blockers.push("offer_size_missing");
    if (!season.firstKickoff) blockers.push("first_kickoff_missing");
    if (!clubsListValid(listed)) blockers.push("clubs_missing");
    try {
      await this.values.assertCupsConfirmed(season.id, executor);
    } catch (error) {
      if (!(error instanceof DomainError && error.code === "cups_not_confirmed")) throw error;
      blockers.push("cups_not_confirmed");
    }
    // Depois do fechamento não abre mais: o admin precisa mudar o primeiro jogo (proposta 6).
    if (season.firstKickoff && now.getTime() >= ipoDates(season.firstKickoff.getTime()).closesAt) blockers.push("past_close");
    return blockers;
  }

  private async listedClubs(executor: Executor, seasonId: number): Promise<ListedClub[]> {
    const rows = await executor
      .select({ clubId: seasonClubs.clubId, ticker: clubs.ticker, division: seasonClubs.division, prevPlacement: seasonClubs.prevPlacement })
      .from(seasonClubs)
      .innerJoin(clubs, eq(clubs.id, seasonClubs.clubId))
      .where(eq(seasonClubs.seasonId, seasonId))
      .orderBy(asc(clubs.ticker));
    // Todo clube listado tem ticker (a F7 recusa a lista sem); um sem ticker invalida a lista.
    return rows.map((r) => ({ ...r, ticker: r.ticker ?? "" }));
  }

  /** Grava `band_center`, `band_floor` e `band_ceiling`, com as copas esperadas na data do fechamento. */
  private async writeBands(tx: Tx, seasonId: number, listed: readonly ListedClub[], closesAtMs: number): Promise<void> {
    const [rules] = await tx.db.select({ buybackBp: seasonRules.buybackMultipleBp }).from(seasonRules).where(eq(seasonRules.seasonId, seasonId));
    if (!rules) throw new Error(`temporada sem valores: ${seasonId}`);
    const values = await this.values.loadSeasonValues(tx, seasonId);
    const cupMatches = await tx.db
      .select()
      .from(matches)
      .where(and(eq(matches.seasonId, seasonId), inArray(matches.competition, [...CUP_COMPETITIONS]), isNotNull(matches.phase)));
    const bands = ipoBands(listed, cupMatches, values, rules.buybackBp, closesAtMs);
    for (const club of listed) {
      const band = bands.get(club.clubId)!;
      await tx.db
        .update(seasonClubs)
        .set({ bandCenter: band.center, bandFloor: band.floor, bandCeiling: band.ceiling })
        .where(and(eq(seasonClubs.seasonId, seasonId), eq(seasonClubs.clubId, club.clubId)));
    }
  }

  /**
   * A tesouraria, sem caixa (recebe o pago e as sobras na liquidação), e os bots ativos com R$ 100.000,00
   * (Admin: "bot ligado antes do fechamento do IPO entra com R$ 100 mil"). Só as que ainda não existem.
   */
  private async openHouseWallets(tx: Tx, seasonId: number, now: Date): Promise<void> {
    const [treasury] = await tx.db
      .select({ id: wallets.id })
      .from(wallets)
      .where(and(eq(wallets.seasonId, seasonId), eq(wallets.ownerType, "treasury")));
    if (!treasury) await this.ledger.openWallet(tx, { seasonId, owner: { type: "treasury" }, at: now });

    const active = await tx.db.select({ id: bots.id }).from(bots).where(eq(bots.active, true)).orderBy(asc(bots.id));
    if (active.length === 0) return;
    const opened = new Set(
      (
        await tx.db
          .select({ botId: wallets.botId })
          .from(wallets)
          .where(and(eq(wallets.seasonId, seasonId), inArray(wallets.botId, active.map((b) => b.id))))
      ).map((w) => w.botId),
    );
    for (const bot of active) {
      if (opened.has(bot.id)) continue;
      await this.ledger.openWallet(tx, {
        seasonId,
        owner: { type: "bot", botId: bot.id },
        at: now,
        entryMode: "ipo",
        initialCash: SEASON_START_CASH,
      });
    }
  }
}
