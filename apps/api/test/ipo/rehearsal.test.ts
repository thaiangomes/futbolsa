import "reflect-metadata";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PutBidBody } from "@futbolsa/contracts";
import { ipoDates, type IpoClubSettlement, mmLot, runBookbuilding, settleIpoClub } from "@futbolsa/engine";
import { FixedClock } from "../../src/infra/clock/index.js";
import { withTransaction } from "../../src/infra/db/index.js";
import { DomainError } from "../../src/infra/http/index.js";
import {
  bots,
  clubs,
  ipoAllocations,
  ipoBids,
  ipoResults,
  positions,
  seasonClubs,
  seasonCups,
  seasons,
  users,
  walletEntries,
  wallets,
} from "../../src/infra/db/schema/index.js";
import { SeasonValuesService } from "../../src/modules/dividends/season-values/season-values.service.js";
import { IpoBidsService, IpoJob, type IpoJobReport } from "../../src/modules/ipo/index.js";
import { createAccount, type TestAccount } from "../support/accounts.js";
import { createTestApp } from "../support/app.js";
import { bearer, withTestAuth } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { INITIAL_CASH, rng, seedSeason } from "../support/fixtures.js";
import { assertLedgerConsistent, assertSharesConserved, totalCash } from "../support/invariants.js";
// Os bots e a visão de mercado da simulação do motor: não fazem parte da API pública do pacote
// (`src/index.ts`), então entram direto do código-fonte. É a mesma lógica que decide as intenções
// de compra no IPO da simulação (`npm run sim`).
import { AnalystBot, AnticipatorBot, CaptureBot, ConcentratorBot, DividendBot, FanBot, MomentumBot, PROFILES, RandomBot, TraderBot, type Bot, type BotProfile } from "../../../../packages/engine/src/sim/bots.js";
import { MarketView } from "../../../../packages/engine/src/sim/market.js";
import { Rng } from "../../../../packages/engine/src/sim/rng.js";
import { Exchange } from "../../../../packages/engine/src/engine/orderbook.js";
import { Ledger } from "../../../../packages/engine/src/engine/ledger.js";
import { BRASILEIRAO_A } from "../../../../packages/engine/src/engine/dividends.js";
import type { PriceBand } from "../../../../packages/engine/src/engine/bookbuilding.js";
import type { Match } from "../../../../packages/engine/src/engine/types.js";

/**
 * Ensaio do IPO inteiro pela API (A9 do Plano do IPO; critérios 16 a 23 e 29 em escala): uma temporada
 * com os 24 clubes listados, 30 jogadores e 18 bots (2 de cada um dos 9 perfis) ofertando ao mesmo
 * tempo, com edições e cancelamentos sorteados (semente fixa), e só o relógio e a tarefa agendada
 * (`IpoJob.runOnce()`) abrindo, fechando e liquidando. No fim o que ficou gravado é comparado com o
 * motor chamado direto (`runBookbuilding` e `settleIpoClub`) e com as invariantes do dinheiro e das ações.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Primeiro jogo em 2027-04-11 às 16h de Brasília: abre em 03-28 às 16h e fecha em 04-04 às 16h. */
const FIRST_KICKOFF = new Date("2027-04-11T19:00:00Z");
const DATES = ipoDates(FIRST_KICKOFF.getTime());
/** Menor que a de produção, para dar rateio em uns clubes e sobra em outros. */
const OFFER = 1000;
const PLAYERS = 30;
const BOTS_PER_PROFILE = 2;
/** Rodadas de edições e cancelamentos sorteados, de 8 h cada: 160 h cabem nos 7 dias (168 h) do período. */
const ROUNDS = 20;
const ROUND_GAP = 8 * HOUR;
/** Em que rodada o jogador que cancela tudo cancela. */
const CANCEL_ALL_ROUND = 12;
/** Quantas chamadas disparadas ao mesmo tempo em cada lote. */
const BATCH = 36;
/** A rota de ofertas aceita 60 chamadas por minuto por pessoa: o teste fica abaixo disso. */
const HTTP_CALLS_PER_PLAYER = 50;

const SERIE_A = [
  "PAL3", "FLU3", "FLA3", "VAS3", "BOT3", "COR3", "SAO3", "SAN3", "GRE3", "INT3",
  "CRU3", "CAM3", "BAH3", "FOR3", "CEA3", "SPT3", "JUV3", "VIT3", "MIR3", "RBB3",
] as const;
/** 16 da Série A anterior e os 4 promovidos (21 a 24). */
const PLACEMENTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 21, 22, 23, 24];
/** Os 4 clubes do Clube dos Treze na Série B que completam os 24 listados (como em settlement.concurrency.test.ts). */
const SERIE_B = ["CTA3", "CTB3", "CTC3", "CTD3"];
/**
 * Clubes caros que quase ninguém quer: poucos bots entram neles e os jogadores só põem ofertas pequenas de
 * vez em quando. É o que deixa a demanda abaixo da oferta e dá sobra para a tesouraria; nos outros clubes
 * a demanda passa da oferta e há rateio.
 */
const UNPOPULAR = new Set(["PAL3", "FLA3", "VAS3", "BOT3"]);

type Actor = {
  name: string;
  kind: "player" | "bot";
  walletId: number;
  /** Jogador que usa as rotas HTTP: o token e quantas chamadas já fez. */
  http?: { token: string; calls: number };
};

type Outcome = { ok: true } | { ok: false; code: string };

type Op = {
  actor: Actor;
  ticker: string;
  /** `place` com `expect: "new"` cria, com `"existing"` edita; `cancel` cancela. */
  kind: "create" | "edit" | "cancel";
  body?: PutBidBody;
};

/** Embaralha uma cópia com o sorteio dado (Fisher-Yates). */
function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Divide em lotes do tamanho dado. */
function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Jogos de todos contra todos, ida e volta, entre os clubes: só para a visão dos bots saber quantos jogos faltam. */
function fixtures(tickers: readonly string[]): Match[] {
  const out: Match[] = [];
  let n = 0;
  for (const home of tickers) {
    for (const away of tickers) {
      if (home === away) continue;
      out.push({
        id: `jogo-${n}`,
        competition: "brasileirao-a",
        round: 1 + Math.floor(n / 12),
        kickoff: new Date(FIRST_KICKOFF.getTime() + Math.floor(n / 12) * 7 * DAY + (n % 12) * 2 * HOUR).toISOString(),
        home,
        away,
        homeGoals: null,
        awayGoals: null,
        status: "scheduled",
      });
      n++;
    }
  }
  return out;
}

/** O bot do perfil, como a simulação do motor o cria (`simulate.ts`). */
function makeBot(profile: BotProfile, id: string, botRng: Rng, club: string, lastYear: ReadonlyMap<string, number>): Bot {
  switch (profile) {
    case "dividendos": return new DividendBot(id, botRng);
    case "momentum": return new MomentumBot(id, botRng);
    case "torcedor": return new FanBot(id, botRng, club);
    case "captura": return new CaptureBot(id, botRng);
    case "analista": return new AnalystBot(id, botRng, lastYear);
    case "concentrador": return new ConcentratorBot(id, botRng);
    case "antecipador": return new AnticipatorBot(id, botRng);
    case "trader": return new TraderBot(id, botRng);
    case "aleatorio": return new RandomBot(id, botRng);
  }
}

describe("ensaio do IPO inteiro pela API", () => {
  const database = useTestDatabase(40);
  const clock = new FixedClock(new Date(DATES.opensAt - 10 * MINUTE));
  let app: NestFastifyApplication;
  let job: IpoJob;
  let bids: IpoBidsService;
  let seasonId: number;
  let clubIds: Map<string, number>;
  /** Os 24 listados, em ordem de ticker. */
  let tickers: string[];
  let players: TestAccount[];

  beforeAll(async () => {
    app = await createTestApp({ db: database.db, clock, override: withTestAuth(clock) });
    job = app.get(IpoJob);
    bids = app.get(IpoBidsService);
    const values = app.get(SeasonValuesService, { strict: false });
    ({ seasonId, clubIds } = await seedSeason(database.db, 2027));
    await database.db.insert(clubs).values(SERIE_B.map((ticker, i) => ({ ticker, name: `Clube dos Treze na Série B ${i + 1} (teste)` })));
    clubIds = new Map((await database.db.select({ id: clubs.id, ticker: clubs.ticker }).from(clubs)).map((c) => [c.ticker!, c.id]));
    tickers = [...SERIE_A, ...SERIE_B].sort();
    expect(tickers).toHaveLength(24);

    const admin = await createAccount(database.db, { role: "admin", nickname: "chefe_ensaio" });
    await withTransaction(database.db, (tx) => values.createInitial(tx, seasonId));
    await database.db.update(seasonCups).set({ confirmedAt: new Date("2027-03-01T12:00:00Z"), confirmedBy: admin.id }).where(eq(seasonCups.seasonId, seasonId));
    // O que o admin deixa pronto antes da abertura: a oferta fixada e o primeiro jogo (as datas saem dele).
    await database.db
      .update(seasons)
      .set({
        offerSize: OFFER,
        firstKickoff: FIRST_KICKOFF,
        ipoOpensAt: new Date(DATES.opensAt),
        ipoClosesAt: new Date(DATES.closesAt),
        tradingOpensAt: new Date(DATES.tradingOpensAt),
      })
      .where(eq(seasons.id, seasonId));
    await database.db.insert(seasonClubs).values([
      ...SERIE_A.map((ticker, i) => ({ seasonId, clubId: clubIds.get(ticker)!, division: "A", prevPlacement: PLACEMENTS[i]! })),
      ...SERIE_B.map((ticker) => ({ seasonId, clubId: clubIds.get(ticker)!, division: "B", prevPlacement: null })),
    ]);

    // 30 jogadores (contas já cadastradas, sem carteira: ela nasce na abertura) e 18 bots ligados.
    players = [];
    for (let i = 0; i < PLAYERS; i++) {
      players.push(await createAccount(database.db, { nickname: `jogador_${String(i + 1).padStart(2, "0")}`, at: new Date(DATES.opensAt - 3 * DAY) }));
    }
    await database.db.insert(bots).values(PROFILES.flatMap((profile) => Array.from({ length: BOTS_PER_PROFILE }, () => ({ profile, active: true }))));
  });
  afterAll(() => app?.close());

  it(
    "16 a 23 e 29: 30 jogadores e 18 bots ofertando, editando e cancelando ao mesmo tempo; o resultado gravado é o do motor e o dinheiro e as ações batem",
    async () => {
      const db = database.db;
      const startedAt = Date.now();
      const random = rng(20270328);
      const unexpected: string[] = [];
      const refusals = new Map<string, number>();
      const stats = { places: 0, creates: 0, edits: 0, cancels: 0, noopEdits: 0, http: 0, service: 0, refused: 0 };

      // ---- Abertura: só o relógio e a tarefa, como em produção --------------------------------------------------
      expect(await job.runOnce()).toMatchObject({ skipped: false, opening: { status: "idle" }, closing: { status: "idle" }, settlement: { status: "idle" } });
      clock.set(new Date(DATES.opensAt));
      const opened = (await job.runOnce()) as Exclude<IpoJobReport, { skipped: true }>;
      expect(opened.opening).toMatchObject({ status: "opened", seasonId, credited: PLAYERS });

      // Carteiras: 30 jogadores (o admin não joga e fica sem carteira) e 18 bots com R$ 100.000,00 e a tesouraria
      // sem caixa, todas abertas pela abertura.
      const walletRows = await db.select().from(wallets).where(eq(wallets.seasonId, seasonId));
      expect(walletRows).toHaveLength(PLAYERS + PROFILES.length * BOTS_PER_PROFILE + 1);
      for (const w of walletRows) expect(w.cash).toBe(w.ownerType === "treasury" ? 0 : INITIAL_CASH);
      const treasuryId = walletRows.find((w) => w.ownerType === "treasury")!.id;
      const playerWallet = new Map(walletRows.filter((w) => w.ownerType === "user").map((w) => [w.userId!, w.id]));
      const botRows = await db.select().from(bots).orderBy(asc(bots.id));
      const botWallet = new Map(walletRows.filter((w) => w.ownerType === "bot").map((w) => [w.botId!, w.id]));

      // As faixas que a abertura gravou, por ticker.
      const bandRows = await db
        .select({ ticker: clubs.ticker, center: seasonClubs.bandCenter, floor: seasonClubs.bandFloor, ceiling: seasonClubs.bandCeiling })
        .from(seasonClubs)
        .innerJoin(clubs, eq(clubs.id, seasonClubs.clubId))
        .where(eq(seasonClubs.seasonId, seasonId));
      expect(bandRows).toHaveLength(24);
      const bands = new Map(bandRows.map((b) => [b.ticker!, { center: b.center!, floor: b.floor!, ceiling: b.ceiling! }]));
      const priceBands = new Map<string, PriceBand>([...bands].map(([ticker, b]) => [ticker, { center: b.center, min: b.floor, max: b.ceiling }]));

      // ---- Quem oferta ------------------------------------------------------------------------------------------
      // Jogadores: um de cada três pelas rotas HTTP (com token que vale o período todo), mais o que edita várias vezes.
      const canceller = players[0]!;
      const editor = players[1]!;
      const actors: Actor[] = [];
      for (const [i, account] of players.entries()) {
        const viaHttp = i % 3 === 0 || i === 1;
        actors.push({
          name: account.nickname,
          kind: "player",
          walletId: playerWallet.get(account.id)!,
          ...(viaHttp ? { http: { token: await account.tokenWith({ at: new Date(DATES.opensAt), expiresIn: 8 * 86_400 }), calls: 0 } } : {}),
        });
      }
      const [cancellerActor, editorActor] = [actors[0]!, actors[1]!];
      const botActors: Actor[] = [];
      const lastYear = new Map(SERIE_A.map((ticker, i) => [ticker as string, PLACEMENTS[i]!]));
      const view = new MarketView(new Exchange(new Ledger()), new Ledger(), tickers, BRASILEIRAO_A, fixtures(tickers));
      view.now = DATES.opensAt;
      const botRng = new Rng(2027);
      const engineBots: Array<{ bot: Bot; actor: Actor }> = [];
      let fan = 0;
      for (const profile of PROFILES) {
        const rows = botRows.filter((b) => b.profile === profile);
        expect(rows).toHaveLength(BOTS_PER_PROFILE);
        for (const [i, row] of rows.entries()) {
          const id = `${profile}-${String(i + 1).padStart(2, "0")}`;
          const club = tickers[(fan++ * 7) % tickers.length]!;
          const actor: Actor = { name: id, kind: "bot", walletId: botWallet.get(row.id)! };
          botActors.push(actor);
          engineBots.push({ bot: makeBot(profile, id, new Rng(Math.floor(botRng.next() * 2 ** 32)), club, lastYear), actor });
        }
      }
      actors.push(...botActors);

      // ---- Execução de uma chamada, pelas rotas ou pelo serviço ------------------------------------------------------
      /** O que a pessoa sabe da própria oferta: só muda quando a chamada dá certo. */
      const model = new Map<string, { status: "active" | "cancelled"; quantity: number; maxPrice: number }>();
      const keyOf = (a: Actor, ticker: string) => `${a.walletId}:${ticker}`;

      async function runOp(op: Op): Promise<Outcome> {
        const { actor, ticker } = op;
        try {
          if (actor.http && actor.http.calls < HTTP_CALLS_PER_PLAYER) {
            actor.http.calls++;
            stats.http++;
            const res =
              op.kind === "cancel"
                ? await app.inject({ method: "DELETE", url: `/ipo/bids/${ticker}`, headers: bearer(actor.http.token) })
                : await app.inject({ method: "PUT", url: `/ipo/bids/${ticker}`, headers: bearer(actor.http.token), payload: op.body });
            if (res.statusCode === 200) return { ok: true };
            const code = (res.json() as { code?: string }).code ?? `http_${res.statusCode}`;
            if (res.statusCode === 429 || res.statusCode >= 500) unexpected.push(`${actor.name} ${op.kind} ${ticker}: ${res.statusCode} ${code}`);
            return { ok: false, code };
          }
          stats.service++;
          if (op.kind === "cancel") await bids.cancel(actor.walletId, ticker);
          else await bids.place(actor.walletId, ticker, op.body!);
          return { ok: true };
        } catch (error) {
          if (error instanceof DomainError) return { ok: false, code: error.code };
          unexpected.push(`${actor.name} ${op.kind} ${ticker}: ${(error as Error).stack ?? String(error)}`);
          return { ok: false, code: "unexpected" };
        }
      }

      /** Dispara os lotes de chamadas ao mesmo tempo, um minuto entre um lote e outro, e atualiza o modelo e as contagens. */
      async function fire(ops: Op[]): Promise<void> {
        for (const batch of chunks(ops, BATCH)) {
          clock.advance(MINUTE);
          const outcomes = await Promise.all(batch.map(runOp));
          batch.forEach((op, i) => {
            const outcome = outcomes[i]!;
            if (op.kind !== "cancel") stats.places++;
            if (!outcome.ok) {
              stats.refused++;
              refusals.set(outcome.code, (refusals.get(outcome.code) ?? 0) + 1);
              return;
            }
            const key = keyOf(op.actor, op.ticker);
            if (op.kind === "cancel") {
              stats.cancels++;
              model.set(key, { ...model.get(key)!, status: "cancelled" });
            } else {
              if (op.kind === "create") stats.creates++;
              else {
                stats.edits++;
                const before = model.get(key);
                if (before && before.quantity === op.body!.quantity && before.maxPrice === op.body!.maxPrice) stats.noopEdits++;
              }
              model.set(key, { status: "active", quantity: op.body!.quantity, maxPrice: op.body!.maxPrice });
            }
          });
        }
      }

      /** Os clubes que alguém sorteia para ofertar: os procurados e, de vez em quando, um dos que ninguém quer. */
      const pickClubs = (count: number): string[] => {
        const chosen = shuffled(tickers.filter((t) => !UNPOPULAR.has(t)), random).slice(0, count);
        if (random() < 0.3) chosen.push(shuffled([...UNPOPULAR], random)[0]!);
        return chosen;
      };

      const create = (actor: Actor, ticker: string, quantity: number, maxPrice: number): Op => ({
        actor,
        ticker,
        kind: "create",
        body: { quantity, maxPrice, expect: "new" },
      });

      // ---- Ofertas iniciais -----------------------------------------------------------------------------------------
      clock.advance(5 * MINUTE);
      const initial: Op[] = [];
      // Bots: as intenções `ipoBids` do motor sobre as faixas gravadas pela abertura.
      for (const { bot, actor } of engineBots) {
        for (const [ticker, bid] of bot.ipoBids(view, priceBands, INITIAL_CASH)) initial.push(create(actor, ticker, bid.quantity, bid.maxPrice));
      }
      const botIntents = initial.length;
      // Jogadores: intenções sorteadas. Do piso (e de vez em quando abaixo dele) a um pouco acima do teto, de
      // 20 a 600 ações; a soma passa do caixa de vez em quando, e aí o serviço recusa.
      const playerOps: Op[] = [];
      for (const actor of actors.filter((a) => a.kind === "player")) {
        const count = actor === cancellerActor ? 6 : actor === editorActor ? 5 : 4 + Math.floor(random() * 8);
        for (const ticker of pickClubs(count)) {
          const band = bands.get(ticker)!;
          const roll = random();
          const maxPrice =
            actor === cancellerActor || actor === editorActor
              ? band.floor + Math.floor(random() * (band.ceiling - band.floor))
              : roll < 0.06 ? Math.floor(band.floor * 0.8)
              : roll < 0.16 ? band.ceiling + 1 + Math.floor(random() * 300)
              : band.floor + Math.floor(random() * (band.ceiling - band.floor));
          const quantity = UNPOPULAR.has(ticker)
            ? 5 + Math.floor(random() * 26)
            : actor === cancellerActor || actor === editorActor
              ? 20 + Math.floor(random() * 40)
              : 20 + Math.floor(random() * 580);
          playerOps.push(create(actor, ticker, quantity, maxPrice));
        }
      }
      // Bots e jogadores misturados, sem uma ordem que separe os dois grupos.
      await fire(shuffled([...initial, ...playerOps], random));
      expect(model.size).toBeGreaterThan(0);

      // ---- Rodadas de edições e cancelamentos -------------------------------------------------------------------------
      const editorClub = [...model].find(([key, m]) => key.startsWith(`${editorActor.walletId}:`) && m.status === "active")![0].split(":")[1]!;
      let editorEdits = 0;
      for (let round = 0; round < ROUNDS; round++) {
        clock.advance(ROUND_GAP);
        const ops: Op[] = [];
        // Quem edita várias vezes: o mesmo clube em toda rodada (com valores novos) e mais dois clubes.
        {
          const band = bands.get(editorClub)!;
          ops.push({
            actor: editorActor,
            ticker: editorClub,
            kind: "edit",
            body: { quantity: 15 + Math.floor(random() * 60), maxPrice: band.floor + Math.floor(random() * (band.ceiling - band.floor)), expect: "existing" },
          });
          editorEdits++;
          const others = [...model].filter(([key, m]) => key.startsWith(`${editorActor.walletId}:`) && m.status === "active" && !key.endsWith(`:${editorClub}`));
          for (const [key] of others.slice(0, 2)) {
            const ticker = key.split(":")[1]!;
            const band = bands.get(ticker)!;
            ops.push({ actor: editorActor, ticker, kind: "edit", body: { quantity: 15 + Math.floor(random() * 60), maxPrice: band.floor + Math.floor(random() * (band.ceiling - band.floor)), expect: "existing" } });
          }
        }
        // Quem cancela tudo: numa rodada só cancela, de uma vez, cada oferta que tem.
        if (round === CANCEL_ALL_ROUND) {
          for (const [key, m] of model) {
            if (key.startsWith(`${cancellerActor.walletId}:`) && m.status === "active") ops.push({ actor: cancellerActor, ticker: key.split(":")[1]!, kind: "cancel" });
          }
          expect(ops.filter((o) => o.actor === cancellerActor).length).toBeGreaterThanOrEqual(3);
        }
        // Os demais: cada um sorteia o que fazer em alguns clubes (no máximo uma chamada por clube por lote).
        for (const actor of actors) {
          if (actor === cancellerActor || actor === editorActor) continue;
          if (random() > (actor.kind === "player" ? 0.7 : 0.2)) continue;
          for (const ticker of pickClubs(1 + Math.floor(random() * 4))) {
            const band = bands.get(ticker)!;
            const current = model.get(keyOf(actor, ticker));
            const active = current?.status === "active" ? current : undefined;
            const roll = random();
            const anyPrice = () => band.floor + Math.floor(random() * (band.ceiling - band.floor + 200));
            if (active) {
              if (roll < 0.15) ops.push({ actor, ticker, kind: "cancel" });
              else if (roll < 0.22) ops.push({ actor, ticker, kind: "edit", body: { quantity: active.quantity, maxPrice: active.maxPrice, expect: "existing" } }); // não muda nada
              else if (roll < 0.27) ops.push(create(actor, ticker, active.quantity, active.maxPrice)); // `new` com oferta ativa: bid_exists
              else if (roll < 0.33) ops.push({ actor, ticker, kind: "edit", body: { quantity: active.quantity * 40, maxPrice: anyPrice(), expect: "existing" } }); // caixa não cobre
              else ops.push({ actor, ticker, kind: "edit", body: { quantity: Math.max(1, Math.round(active.quantity * (0.4 + random() * 1.3))), maxPrice: random() < 0.1 ? Math.floor(band.floor * 0.7) : anyPrice(), expect: "existing" } });
            } else if (roll < 0.08) {
              ops.push({ actor, ticker, kind: "edit", body: { quantity: 50, maxPrice: anyPrice(), expect: "existing" } }); // não há oferta: bid_not_found
            } else if (roll < 0.14 && !current) {
              ops.push({ actor, ticker, kind: "cancel" }); // não há o que cancelar
            } else {
              // Oferta nova (ou de volta, depois de cancelar): o clube do jogador que não tinha nada ou cancelou.
              ops.push(create(actor, ticker, UNPOPULAR.has(ticker) ? 5 + Math.floor(random() * 26) : 10 + Math.floor(random() * 300), anyPrice()));
            }
          }
        }
        await fire(shuffled(ops, random));
      }
      expect(editorEdits).toBe(ROUNDS);

      // ---- O que as chamadas deixaram gravado, antes do fechamento ------------------------------------------------------
      expect(unexpected, unexpected.join("\n")).toEqual([]);
      // Todas as chamadas couberam no período (nenhuma foi recusada por `ipo_closed`).
      expect(clock.now().getTime()).toBeLessThan(DATES.closesAt - MINUTE);
      expect(refusals.get("ipo_closed") ?? 0).toBe(0);
      clock.set(new Date(DATES.closesAt - MINUTE));
      const allBids = await db.select().from(ipoBids).where(eq(ipoBids.seasonId, seasonId)).orderBy(asc(ipoBids.id));
      const finalBids = allBids.filter((b) => b.status === "active");
      expect(allBids.every((b) => b.status === "active" || b.status === "cancelled")).toBe(true);
      const tickerOfClub = new Map([...clubIds].map(([ticker, id]) => [id, ticker]));
      // O modelo (o que as respostas disseram) é o que o banco guardou, oferta por oferta.
      for (const b of allBids) {
        const m = model.get(`${b.walletId}:${tickerOfClub.get(b.clubId)}`)!;
        expect(m, `oferta ${b.id}`).toMatchObject({ status: b.status, quantity: b.quantity, maxPrice: b.maxPrice });
      }
      expect(allBids).toHaveLength(model.size);
      // A reserva de cada carteira é a soma das reservas das ofertas ativas, e cabe no caixa.
      const reservedBefore = new Map<number, number>();
      for (const b of finalBids) reservedBefore.set(b.walletId, (reservedBefore.get(b.walletId) ?? 0) + b.reserved);
      const beforeWallets = new Map((await db.select().from(wallets).where(eq(wallets.seasonId, seasonId))).map((w) => [w.id, w]));
      for (const w of beforeWallets.values()) {
        expect(w.reservedCash, `reserva da carteira ${w.id}`).toBe(reservedBefore.get(w.id) ?? 0);
        expect(w.reservedCash).toBeLessThanOrEqual(w.cash);
      }
      // Quem cancelou tudo não tem oferta ativa; o que editou várias vezes tem a última edição gravada.
      expect(finalBids.filter((b) => b.walletId === cancellerActor.walletId)).toHaveLength(0);
      expect(allBids.filter((b) => b.walletId === cancellerActor.walletId).length).toBeGreaterThanOrEqual(3);
      expect(beforeWallets.get(cancellerActor.walletId)!.reservedCash).toBe(0);
      const editorBid = allBids.find((b) => b.walletId === editorActor.walletId && tickerOfClub.get(b.clubId) === editorClub)!;
      expect(editorBid.updatedAt.getTime()).toBeGreaterThan(editorBid.createdAt.getTime() + (ROUNDS - 1) * ROUND_GAP);
      expect(finalBids.length).toBeGreaterThan(200);
      expect(new Set(finalBids.map((b) => b.walletId)).size).toBeGreaterThanOrEqual(40);

      // Fora do período não se oferta mais (critério 14), mesmo antes de a tarefa fechar.
      clock.set(new Date(DATES.closesAt));
      await expect(bids.place(botActors[0]!.walletId, tickers[0]!, { quantity: 1, maxPrice: 100_000, expect: "new" })).rejects.toMatchObject({ code: "ipo_closed" });
      const lateHttp = await app.inject({ method: "DELETE", url: `/ipo/bids/${tickers[0]}`, headers: bearer(editorActor.http!.token) });
      expect(lateHttp.json().code).toBe("ipo_closed");

      // O que cada lado tem antes de fechar e liquidar.
      const cashOf = async (ownerType: "user" | "bot" | "treasury") =>
        Number(
          (await db.execute(sql`select coalesce(sum(cash), 0)::bigint as total from futbolsa.wallets where season_id = ${seasonId} and owner_type = ${ownerType}`)).rows[0]!.total,
        );
      const before = { users: await cashOf("user"), bots: await cashOf("bot"), treasury: await cashOf("treasury"), all: await totalCash(db, seasonId) };
      expect(before.treasury).toBe(0);
      expect(before.all).toBe((PLAYERS + PROFILES.length * BOTS_PER_PROFILE) * INITIAL_CASH);

      // ---- Fechar e liquidar: só a tarefa --------------------------------------------------------------------------------
      const report = (await job.runOnce()) as Exclude<IpoJobReport, { skipped: true }>;
      expect(report.closing).toMatchObject({ status: "closed" });
      expect(report.settlement).toMatchObject({ status: "ran", failed: [], pending: 0 });
      expect((report.settlement as { settled: string[] }).settled).toEqual(tickers);
      expect((await db.select().from(seasons).where(eq(seasons.id, seasonId)))[0]!.status).toBe("ipo_closed");

      // ---- (a) cada clube: o gravado é o do motor chamado direto ----------------------------------------------------------
      const [season] = await db.select().from(seasons).where(eq(seasons.id, seasonId));
      const results = new Map((await db.select().from(ipoResults).where(eq(ipoResults.seasonId, seasonId))).map((r) => [r.clubId, r]));
      expect(results.size).toBe(24);
      const allocations = new Map(
        (await db.select().from(ipoAllocations).where(inArray(ipoAllocations.bidId, allBids.map((b) => b.id)))).map((a) => [a.bidId, a]),
      );
      const expected = new Map<number, IpoClubSettlement>();
      let withRatio = 0;
      let withLeftover = 0;
      let paidTotal = 0;
      for (const ticker of tickers) {
        const clubId = clubIds.get(ticker)!;
        const band = bands.get(ticker)!;
        const bidsOfClub = finalBids.filter((b) => b.clubId === clubId);
        const oracle = settleIpoClub({
          offer: OFFER,
          band: { floor: band.floor, ceiling: band.ceiling },
          lotBp: season!.mmLotBp,
          bids: bidsOfClub.map((b) => ({ id: b.id, walletId: b.walletId, quantity: b.quantity, maxPrice: b.maxPrice, reserved: b.reserved, updatedAt: b.updatedAt.getTime() })),
        });
        expected.set(clubId, oracle);
        const result = results.get(clubId)!;
        expect(result, ticker).toMatchObject({
          cutPrice: oracle.cutPrice,
          demandAtCut: oracle.demandAtCut,
          allocationNum: oracle.ratio.num,
          allocationDen: oracle.ratio.den,
          treasuryShares: oracle.leftoverShares,
          mmLotShares: oracle.lotShares,
        });
        expect(oracle.lotShares).toBe(mmLot(OFFER, season!.mmLotBp));
        // O motor de bookbuilding chamado direto, com as ofertas finais na ordem da última alteração e depois do id.
        const ordered = [...bidsOfClub].sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime() || a.id - b.id);
        const direct = runBookbuilding(OFFER, { center: band.floor, min: band.floor, max: band.ceiling }, ordered.map((b) => ({ investorId: String(b.id), quantity: b.quantity, maxPrice: b.maxPrice })));
        expect(result.cutPrice, ticker).toBe(direct.price);
        expect(result.demandAtCut).toBe(direct.demandAtPrice);
        expect(result.treasuryShares).toBe(direct.treasuryShares);
        const directShares = new Map(direct.allocations.map((a) => [a.investorId, a.quantity]));
        // Cada oferta ativa tem a sua alocação, igual à do oráculo e à do motor; a cancelada não tem.
        expect(oracle.allocations).toHaveLength(bidsOfClub.length);
        for (const a of oracle.allocations) {
          expect(allocations.get(a.bidId), `oferta ${a.bidId} de ${ticker}`).toEqual({ bidId: a.bidId, shares: a.shares, paid: a.paid, refunded: a.refunded });
          expect(a.shares).toBe(directShares.get(String(a.bidId)) ?? 0);
          paidTotal += a.paid;
        }
        for (const b of allBids.filter((x) => x.clubId === clubId && x.status === "cancelled")) expect(allocations.has(b.id)).toBe(false);
        // Preço e ações do clube na temporada: o corte e a oferta mais o lote.
        const [row] = await db.select().from(seasonClubs).where(and(eq(seasonClubs.seasonId, seasonId), eq(seasonClubs.clubId, clubId)));
        expect(row).toMatchObject({ ipoPrice: oracle.cutPrice, lastPrice: oracle.cutPrice, totalShares: OFFER + oracle.lotShares });
        if (oracle.ratio.den > 1) withRatio++;
        if (oracle.leftoverShares > 0) withLeftover++;
      }

      // As ações de cada carteira por clube são as alocadas; a tesouraria tem a sobra e o lote.
      const heldRows = await db
        .select({ walletId: positions.walletId, clubId: positions.clubId, shares: positions.shares })
        .from(positions)
        .innerJoin(wallets, eq(wallets.id, positions.walletId))
        .where(eq(wallets.seasonId, seasonId));
      const held = new Map(heldRows.filter((p) => p.shares > 0).map((p) => [`${p.walletId}:${p.clubId}`, p.shares]));
      const wantHeld = new Map<string, number>();
      const paidBy = new Map<number, number>();
      for (const [clubId, o] of expected) {
        for (const a of o.allocations) {
          if (a.shares > 0) wantHeld.set(`${a.walletId}:${clubId}`, a.shares);
          paidBy.set(a.walletId, (paidBy.get(a.walletId) ?? 0) + a.paid);
        }
        if (o.leftoverShares + o.lotShares > 0) wantHeld.set(`${treasuryId}:${clubId}`, o.leftoverShares + o.lotShares);
      }
      expect(held).toEqual(wantHeld);

      // ---- (b) dinheiro conservado --------------------------------------------------------------------------------------
      const after = { users: await cashOf("user"), bots: await cashOf("bot"), treasury: await cashOf("treasury"), all: await totalCash(db, seasonId) };
      expect(after.all).toBe(before.all);
      const bidderDrop = before.users + before.bots - (after.users + after.bots);
      expect(bidderDrop).toBe(after.treasury - before.treasury);
      expect(after.treasury).toBe(paidTotal);
      expect(paidTotal).toBe([...expected.values()].reduce((sum, o) => sum + o.treasuryCash, 0));
      expect(paidTotal).toBeGreaterThan(0);
      const afterWallets = new Map((await db.select().from(wallets).where(eq(wallets.seasonId, seasonId))).map((w) => [w.id, w]));
      for (const [walletId, w] of afterWallets) {
        if (walletId === treasuryId) continue;
        expect(w.cash, `caixa da carteira ${walletId}`).toBe(beforeWallets.get(walletId)!.cash - (paidBy.get(walletId) ?? 0));
      }

      // ---- (c) ações, (d) reservas, (e) extrato ---------------------------------------------------------------------------
      await assertSharesConserved(db, seasonId);
      for (const w of afterWallets.values()) expect(w.reservedCash, `reserva da carteira ${w.id}`).toBe(0);
      expect(await db.select({ id: ipoBids.id }).from(ipoBids).where(and(eq(ipoBids.seasonId, seasonId), eq(ipoBids.status, "active")))).toHaveLength(0);
      expect((await db.select().from(ipoBids).where(and(eq(ipoBids.seasonId, seasonId), eq(ipoBids.status, "settled")))).length).toBe(finalBids.length);
      await assertLedgerConsistent(db, seasonId);
      // Quem cancelou tudo continua com os R$ 100.000,00 e nenhuma ação; e nenhuma linha `ipo_settle` por oferta repetida.
      expect(afterWallets.get(cancellerActor.walletId)).toMatchObject({ cash: INITIAL_CASH, reservedCash: 0 });
      const settleLines = await db
        .select({ refId: walletEntries.refId })
        .from(walletEntries)
        .where(and(eq(walletEntries.kind, "ipo_settle"), eq(walletEntries.refType, "ipo_bid"), inArray(walletEntries.refId, allBids.map((b) => String(b.id)))));
      expect(settleLines).toHaveLength(finalBids.length);
      expect(new Set(settleLines.map((l) => l.refId)).size).toBe(finalBids.length);

      // ---- (f) outra passada da tarefa não muda nada ------------------------------------------------------------------------
      const summary = async () => {
        const one = async (query: ReturnType<typeof sql>) => (await db.execute(query)).rows[0]!;
        return {
          results: await one(sql`select count(*)::int n, sum(cut_price)::bigint cut, sum(demand_at_cut)::bigint demand, sum(treasury_shares)::bigint treasury, sum(mm_lot_shares)::bigint lot, sum(allocation_num)::bigint num, sum(allocation_den)::bigint den, max(settled_at) settled_at from futbolsa.ipo_results`),
          allocations: await one(sql`select count(*)::int n, sum(shares)::bigint shares, sum(paid)::bigint paid, sum(refunded)::bigint refunded from futbolsa.ipo_allocations`),
          bids: await one(sql`select count(*)::int n, sum(reserved)::bigint reserved, sum(quantity)::bigint quantity, count(*) filter (where status = 'settled')::int settled from futbolsa.ipo_bids`),
          wallets: await one(sql`select count(*)::int n, sum(cash)::bigint cash, sum(reserved_cash)::bigint reserved from futbolsa.wallets`),
          positions: await one(sql`select count(*)::int n, sum(shares)::bigint shares from futbolsa.positions`),
          entries: await one(sql`select count(*)::int n, sum(cash_delta)::bigint cash, sum(reserved_cash_delta)::bigint reserved, sum(shares_delta)::bigint shares, max(id)::bigint last_id from futbolsa.wallet_entries`),
          clubs: await one(sql`select sum(total_shares)::bigint shares, sum(ipo_price)::bigint price from futbolsa.season_clubs`),
        };
      };
      const snapshot = await summary();
      expect(snapshot.entries.n).toBeGreaterThan(0);
      clock.advance(3 * MINUTE);
      const again = (await job.runOnce()) as Exclude<IpoJobReport, { skipped: true }>;
      expect(again).toMatchObject({ opening: { status: "idle" }, closing: { status: "idle" }, settlement: { status: "ran", settled: [], failed: [], pending: 0 } });
      expect((again.settlement as { skipped: string[] }).skipped).toEqual(tickers);
      expect(await summary()).toEqual(snapshot);

      // ---- Números do ensaio, para o relatório ---------------------------------------------------------------------------
      expect(withRatio).toBeGreaterThan(0);
      expect(withLeftover).toBeGreaterThan(0);
      expect(editorEdits).toBeGreaterThanOrEqual(ROUNDS);
      const byCode = Object.fromEntries([...refusals].sort(([a], [b]) => (a < b ? -1 : 1)));
      const eligibleUsers = (await db.select({ n: sql<number>`count(*)::int` }).from(users).where(eq(users.status, "active")))[0]!.n;
      console.info(
        [
          `ensaio do IPO: ${eligibleUsers} contas, ${actors.length} ofertantes (${PLAYERS} jogadores, ${botActors.length} bots), ${tickers.length} clubes, oferta de ${OFFER} ações por clube`,
          `  intenções iniciais dos bots: ${botIntents}; chamadas de criar ou editar: ${stats.places}`,
          `  aceitas: ${stats.creates} criações, ${stats.edits} edições (${stats.noopEdits} sem mudança), ${stats.cancels} cancelamentos; recusadas: ${stats.refused} ${JSON.stringify(byCode)}`,
          `  pelas rotas HTTP: ${stats.http}; direto pelo serviço: ${stats.service}`,
          `  ofertas gravadas: ${allBids.length} (${finalBids.length} ativas no fechamento, ${allBids.length - finalBids.length} canceladas)`,
          `  clubes com rateio: ${withRatio}; com sobra para a tesouraria: ${withLeftover}; pago à tesouraria: R$ ${(paidTotal / 100).toFixed(2)}`,
          `  tempo: ${((Date.now() - startedAt) / 1000).toFixed(1)} s`,
        ].join("\n"),
      );
    },
    300_000,
  );
});
