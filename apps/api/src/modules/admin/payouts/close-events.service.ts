import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { and, eq, inArray, ne } from "drizzle-orm";
import { type EventsResult, eventsFor, type PayoutEvent, type PayoutEventKind } from "@futbolsa/engine";
import { DB, type Database, lockSeason, type Tx, withTransaction } from "../../../infra/db/index.js";
import { payoutEvents, seasons } from "../../../infra/db/schema/index.js";
import { COMPETITIONS } from "../../../infra/db/schema/values.js";
import { MarketPort } from "../results/ports.js";
import { EngineInputService, LEAGUE_COMPETITIONS, type SeasonEngineInput } from "./engine-input.js";
import { copyHoldings, holdingsAt, writeHoldings } from "./holdings.js";
import { PayoutEvents } from "./events.js";
import { RankingsPort } from "./ports.js";

/**
 * Margem do fechamento (P8): só vira evento o que fechou ao menos 2 minutos antes de agora. Assim nenhuma
 * transação com horário anterior ao fechamento ainda está para fazer `COMMIT` quando a foto é lida, e um
 * fechamento no futuro (placar preenchido antes do fim previsto) não gera evento. A tarefa de cada minuto pega
 * o que ficou para trás.
 */
export const CLOSE_MARGIN_MS = 2 * 60_000;

/**
 * Uma fonte de eventos de pagamento, por tipo (o ponto de extensão do Plano dos dividendos e pagamentos,
 * "Ganchos"): a F12 registra só a dos dividendos; a F15 registra a da recompra (`buybackEvents`).
 * A passada só considera os eventos dos tipos de que alguma fonte é dona, e só mexe nas linhas desses tipos.
 */
export interface PayoutEventSource {
  name: string;
  /** Os tipos de evento que esta fonte calcula (e cujas linhas gravadas ela pode substituir). */
  kinds: readonly PayoutEventKind[];
  events(loaded: SeasonEngineInput): readonly PayoutEvent[];
  /**
   * Se a fonte vale nesta passada (padrão: sempre). Fonte inativa não é dona de nada na passada: as linhas dos tipos
   * dela ficam como estão. A recompra só vale com a negociação encerrada (`tradingEndedAt`); sem isso, uma passada que
   * leu a temporada antes do fechamento da recompra substituiria os eventos de recompra que outra acabou de gravar.
   */
  active?(loaded: SeasonEngineInput): boolean;
}

/** O `eventsFor` da entrada carregada, calculado uma vez por entrada (os dividendos e a recompra usam o mesmo). */
const RESULTS = new WeakMap<SeasonEngineInput, EventsResult>();
export function eventsResultOf(loaded: SeasonEngineInput): EventsResult {
  let result = RESULTS.get(loaded);
  if (!result) RESULTS.set(loaded, (result = eventsFor(loaded.input)));
  return result;
}

/**
 * A competição gravada em `payout_events.competition`: a do motor, ou `null` quando não é uma das competições do
 * esquema (a recompra é da `temporada`; a chave `buyback|temporada|fim|<clube>` guarda o resto).
 */
export const storedCompetition = (competition: string): string | null =>
  (COMPETITIONS as readonly string[]).includes(competition) ? competition : null;

/**
 * Um passo no fim de cada passada, com a entrada que ela leu: o ponto onde a F15 fecha a recompra. O erro vai para
 * `CloseSummary.errors` e não desfaz o que a passada gravou.
 */
export type AfterPassHook = (seasonId: number, loaded: SeasonEngineInput, now: Date) => Promise<void>;

/** Os dividendos: pontos, colocação, acesso, fases e títulos das copas, pelo `eventsFor` do motor. A recompra fica de fora. */
export const DIVIDEND_EVENTS: PayoutEventSource = {
  name: "dividendos",
  kinds: ["points", "placement", "qualification", "relegation", "promotion", "cup_phase", "cup_title"],
  events: (loaded) => eventsResultOf(loaded).events,
};

/** O que uma passada fez. */
export interface CloseSummary {
  /** Eventos novos gravados como `pending`. */
  created: number;
  /** `pending` que mudaram e ganharam versão nova. */
  versioned: number;
  /** `pending` que sumiram do resultado e viraram `superseded` sem substituto. */
  superseded: number;
  /** Eventos novos em grupo (competição e rodada ou fase) já aprovado: ficam para a correção (P4). */
  deferred: number;
  /** Falha na gravação de um clube (a transação dele desfez; a próxima passada tenta de novo). */
  errors: string[];
}

/** O que mudou num clube, para o aviso depois do `COMMIT` (`admin.pending`, na T9). */
export interface ClubCloseChange {
  seasonId: number;
  clubId: number;
  ticker: string;
  created: number;
  versioned: number;
  superseded: number;
  closedAts: Date[];
}

type EventRow = typeof payoutEvents.$inferSelect;

/** O que fazer com um clube: os eventos novos, os que mudaram e os que sumiram. */
interface ClubPlan {
  clubId: number;
  ticker: string;
  create: PayoutEvent[];
  version: Array<{ current: EventRow; next: PayoutEvent }>;
  vanish: EventRow[];
}

const emptySummary = (): CloseSummary => ({ created: 0, versioned: 0, superseded: 0, deferred: 0, errors: [] });

const isLeague = (competition: string) => (LEAGUE_COMPETITIONS as readonly string[]).includes(competition);

/** A rodada (pontos corridos, `stage` numérico) ou a fase (copas); `fim` não é nem uma nem outra. */
export function roundAndPhase(event: PayoutEvent): { round: number | null; phase: string | null } {
  if (isLeague(event.competition)) return { round: /^\d+$/.test(event.stage) ? Number(event.stage) : null, phase: null };
  return { round: null, phase: event.stage === "fim" ? null : event.stage };
}

/**
 * O grupo do evento: a competição e a rodada ou fase (o `stage`); a colocação, o acesso e os pontos pagos no
 * fechamento do campeonato ficam no grupo `competição|fim`. Sai da chave (`tipo|competição|stage|clube`).
 */
export const groupOfKey = (key: string) => key.split("|").slice(1, 3).join("|");

/**
 * A passada de fechamento dos eventos de pagamento (Plano dos dividendos e pagamentos, T3; Admin, critérios 1,
 * 9, 10 e 11). Calcula os eventos com o motor e grava os que fecharam como **aguardando aprovação**, cada um com
 * a foto das posições no fechamento. Nada cai no caixa: o crédito é da aprovação (T5).
 *
 * Versões: cada chave (`temporada`, `clube`, `event_key`) tem uma versão vigente; mudar um `pending` cria a
 * versão seguinte e a anterior vira `superseded` (corrigir antes da aprovação só refaz a prévia, critério 11).
 * Um `approved` nunca é tocado aqui: o que mudou nele aparece no plano da correção (T6).
 *
 * Repetível e sem duplicar: uma passada por vez por temporada nesta API (fila em memória) e, como rede de
 * segurança entre instâncias, o `INSERT … ON CONFLICT DO NOTHING` sobre o único parcial
 * `payout_events_current_key` e o `UPDATE … WHERE status = 'pending'` na troca de versão: quem perde a corrida
 * não grava nada. Nenhuma trava de clube nem de carteira (fechar um evento não mexe em dinheiro); só a
 * temporada, compartilhada, para não fechar durante o encerramento.
 */
@Injectable()
export class CloseEventsService {
  private readonly logger = new Logger("Pagamentos");
  private readonly sources: PayoutEventSource[] = [DIVIDEND_EVENTS];
  private readonly afterPass: AfterPassHook[] = [];
  /** A passada em curso de cada temporada: a seguinte espera ela acabar. */
  private readonly running = new Map<number, Promise<unknown>>();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly engineInput: EngineInputService,
    private readonly market: MarketPort,
    private readonly rankings: RankingsPort,
    @Optional() private readonly events?: PayoutEvents,
  ) {}

  /** Acrescenta uma fonte de eventos (a F15 registra a da recompra). */
  registerSource(source: PayoutEventSource): void {
    this.sources.push(source);
  }

  /** Acrescenta um passo no fim de cada passada (a F15 fecha a recompra nele). */
  registerAfterPass(hook: AfterPassHook): void {
    this.afterPass.push(hook);
  }

  /** Roda a passada da temporada no instante `now`. Temporada encerrada (ou inexistente): não faz nada. */
  closeEvents(seasonId: number, now: Date): Promise<CloseSummary> {
    const previous = this.running.get(seasonId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.pass(seasonId, now));
    this.running.set(seasonId, next);
    const cleanup = () => {
      if (this.running.get(seasonId) === next) this.running.delete(seasonId);
    };
    next.then(cleanup, cleanup);
    return next;
  }

  /**
   * Depois do `COMMIT` de um clube que mudou. Ponto de extensão do aviso `admin.pending` ao admin, que a T9
   * liga ao barramento de tempo real; por ora só registra no log.
   */
  onChanged(change: ClubCloseChange): void {
    this.logger.debug(
      `temporada ${change.seasonId}, ${change.ticker}: ${change.created} novos, ${change.versioned} com versão nova, ${change.superseded} substituídos`,
    );
    void this.events?.adminChanged();
  }

  private async pass(seasonId: number, now: Date): Promise<CloseSummary> {
    const summary = emptySummary();
    const [season] = await this.db.select({ status: seasons.status }).from(seasons).where(eq(seasons.id, seasonId));
    if (!season || season.status === "closed") return summary;

    // 1. fora de transação: a entrada do motor e as funções puras
    const loaded = await this.engineInput.load(this.db, seasonId);
    const sources = this.sources.filter((s) => s.active?.(loaded) ?? true);
    const managed = new Set<string>(sources.flatMap((s) => s.kinds));
    const computed = new Map<string, PayoutEvent>();
    for (const source of sources) {
      const own = new Set<string>(source.kinds);
      for (const event of source.events(loaded)) {
        // só os tipos de que a fonte é dona: a recompra (`buyback`) fica de fora até a F15 registrar a dela
        if (own.has(event.kind)) computed.set(`${loaded.clubIdOf(event.clubId)}|${event.key}`, event);
      }
    }

    const current = await this.db
      .select()
      .from(payoutEvents)
      .where(
        and(
          eq(payoutEvents.seasonId, seasonId),
          ne(payoutEvents.status, "superseded"),
          inArray(payoutEvents.kind, [...managed]),
        ),
      );
    const currentByKey = new Map(current.map((r) => [`${r.clubId}|${r.eventKey}`, r]));
    const approvedGroups = new Set(current.filter((r) => r.status === "approved").map((r) => groupOfKey(r.eventKey)));

    // 2 e 3. compara cada evento fechado com a versão vigente da chave
    const limit = now.getTime() - CLOSE_MARGIN_MS;
    const plans = new Map<number, ClubPlan>();
    const planOf = (clubId: number, ticker: string) => {
      let plan = plans.get(clubId);
      if (!plan) plans.set(clubId, (plan = { clubId, ticker, create: [], version: [], vanish: [] }));
      return plan;
    };
    for (const [key, event] of computed) {
      // fechamento no futuro ou a menos de 2 minutos: espera (um `pending` vigente da chave também espera)
      if (event.closedAt > limit) continue;
      const clubId = loaded.clubIdOf(event.clubId);
      const row = currentByKey.get(key);
      if (!row) {
        if (approvedGroups.has(groupOfKey(event.key))) {
          // a rodada ou fase já foi paga: o evento novo entra na correção, já aprovado (P4, T6)
          summary.deferred++;
          continue;
        }
        planOf(clubId, event.clubId).create.push(event);
      } else if (row.status === "pending" && (row.perShare !== event.perShare || row.closedAt.getTime() !== event.closedAt)) {
        planOf(clubId, event.clubId).version.push({ current: row, next: event });
      }
      // `pending` igual: nada; `approved` diferente: fica para a correção
    }
    for (const [key, row] of currentByKey) {
      // `pending` que não está mais no resultado (nem para fechar mais tarde) vira `superseded` sem substituto
      if (row.status === "pending" && !computed.has(key)) planOf(row.clubId, loaded.tickerOf(row.clubId)).vanish.push(row);
    }

    // 4 a 6. uma transação curta por clube
    for (const plan of [...plans.values()].sort((a, b) => (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0))) {
      try {
        const change = await withTransaction(this.db, (tx) => this.writeClub(tx, seasonId, plan, now));
        summary.created += change.created;
        summary.versioned += change.versioned;
        summary.superseded += change.superseded;
      } catch (error) {
        const message = `${plan.ticker}: ${(error as Error).message}`;
        this.logger.error(`fechamento da temporada ${seasonId} falhou em ${message}`);
        summary.errors.push(message);
      }
    }

    // 7. os passos registrados (o fechamento da recompra, F15), com os eventos regulares já gravados
    for (const hook of this.afterPass) {
      try {
        await hook(seasonId, loaded, now);
      } catch (error) {
        const message = `depois da passada: ${(error as Error).message}`;
        this.logger.error(`fechamento da temporada ${seasonId} falhou ${message}`);
        summary.errors.push(message);
      }
    }
    return summary;
  }

  /** Grava o que mudou num clube, na mesma transação do pedido de reposição e do aviso aos rankings. */
  private async writeClub(tx: Tx, seasonId: number, plan: ClubPlan, now: Date): Promise<ClubCloseChange> {
    const change: ClubCloseChange = { seasonId, clubId: plan.clubId, ticker: plan.ticker, created: 0, versioned: 0, superseded: 0, closedAts: [] };
    const season = await lockSeason(tx, seasonId, "share");
    if (season.status === "closed") return change; // encerrada entre a leitura e a trava

    for (const event of plan.create) {
      const id = await this.insertEvent(tx, seasonId, plan.clubId, event, now, 1, null);
      // sem linha: outra passada gravou a mesma chave antes (a rede de segurança do único parcial)
      if (id === null) continue;
      await writeHoldings(tx, id, await holdingsAt(tx, seasonId, plan.clubId, new Date(event.closedAt)));
      change.created++;
      change.closedAts.push(new Date(event.closedAt));
    }

    for (const { current, next } of plan.version) {
      if (!(await this.supersede(tx, current.id))) continue; // aprovado ou substituído nesse meio tempo
      const id = await this.insertEvent(tx, seasonId, plan.clubId, next, now, current.version + 1, current.id);
      if (id === null) throw new Error(`versão vigente duplicada da chave ${next.key}`);
      if (current.closedAt.getTime() === next.closedAt) {
        // o fechamento não mudou: quem recebe também não
        await copyHoldings(tx, current.id, id);
      } else {
        await writeHoldings(tx, id, await holdingsAt(tx, seasonId, plan.clubId, new Date(next.closedAt)));
        change.closedAts.push(current.closedAt);
      }
      change.versioned++;
      change.closedAts.push(new Date(next.closedAt));
    }

    for (const row of plan.vanish) {
      if (!(await this.supersede(tx, row.id))) continue;
      change.superseded++;
      change.closedAts.push(row.closedAt);
    }

    if (change.created + change.versioned + change.superseded === 0) return change;
    const closedAts = [...new Map(change.closedAts.map((d) => [d.getTime(), d])).values()].sort((a, b) => a.getTime() - b.getTime());
    change.closedAts = closedAts;
    // o "a receber" do mês de cada fechamento muda, inclusive quando o evento nasce depois de o mês fechar
    await this.rankings.payoutsChanged(tx, { seasonId, closedAts });
    // o valor do clube mudou: a casa repõe a cotação (com a negociação encerrada, a casa não cota mais)
    if (season.status !== "trading_ended") await this.market.requestRefresh(tx, [plan.ticker], "close");
    tx.afterCommit(async () => {
      await this.rankings.wake();
      this.onChanged(change);
    });
    return change;
  }

  /** `INSERT … ON CONFLICT DO NOTHING`: devolve o id, ou `null` se a chave já tem versão vigente. */
  private async insertEvent(
    tx: Tx,
    seasonId: number,
    clubId: number,
    event: PayoutEvent,
    now: Date,
    version: number,
    supersedesId: number | null,
  ): Promise<number | null> {
    const [row] = await tx.db
      .insert(payoutEvents)
      .values({
        seasonId,
        clubId,
        eventKey: event.key,
        kind: event.kind,
        reason: event.reason,
        competition: storedCompetition(event.competition),
        ...roundAndPhase(event),
        perShare: event.perShare,
        closedAt: new Date(event.closedAt),
        status: "pending",
        version,
        supersedesId,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: payoutEvents.id });
    return row?.id ?? null;
  }

  /** Passa um `pending` a `superseded`; `false` se ele não está mais `pending` (aprovado ou já substituído). */
  private async supersede(tx: Tx, id: number): Promise<boolean> {
    const rows = await tx.db
      .update(payoutEvents)
      .set({ status: "superseded" })
      .where(and(eq(payoutEvents.id, id), eq(payoutEvents.status, "pending")))
      .returning({ id: payoutEvents.id });
    return rows.length > 0;
  }
}
