/**
 * Rodadas W e X da calibração: lote do formador e quantidade mínima por lado da casa (W)
 * e túnel de preço com leilão (X), num jogo pequeno (20 jogadores, 3.000 ações por clube na oferta).
 *
 * Usa o motor da `main` (commit 539f662) sem mudá-lo. O que este script faz por
 * conta própria, seguindo as especificações aprovadas:
 * - oferta fixa de 3.000 ações por clube e o lote do formador emitido para a tesouraria;
 * - formador no valor justo, faixa de 10% (14% em jogo), "nunca melhor que o mercado"
 *   com margem de 5%, quantidade de 0,25% (0,06% em jogo) das ações do clube, com mínimo;
 * - limite de 20% em volta do preço exibido para as ordens dos jogadores;
 * - opcional: dois infladores combinados que, no fim de cada mês, sobem o preço
 *   de um clube com negócios de 1 ação a +20% entre eles (modo "pump");
 * - opcional: um fanático que compra o mesmo clube a cada 3 horas, até 3× o valor justo (modo "fan");
 * - opcional: a dupla paciente, que sobe só até a beira do túnel na última semana do mês (modo "slow");
 * - opcional: túnel de preço com leilão, como o da B3 (--tuneis 0.1,0.2).
 *
 * Uso (em packages/engine): npx tsx scripts/sim-lote-formador.mts --lotes 0,0.05,0.1,0.2 --minimos 0 --sementes 10 --modos base,pump,fan --out resultados.json
 * Tabelas: node scripts/sim-lote-formador-tabelas.cjs resultados.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
const ENGINE = new URL("../src", import.meta.url).href;
const { priceBand, runBookbuilding, suggestedPrice } = await import(`${ENGINE}/engine/bookbuilding.ts`);
const dividendsMod = await import(`${ENGINE}/engine/dividends.ts`);
const { applyBuyback, applyPayout, BRASILEIRAO_A, COPA_DO_BRASIL, LIBERTADORES, SULAMERICANA, roundCloseTimes, scheduleBuyback, scheduleCupPayouts, scheduleLeaguePayouts } = dividendsMod;
const { Ledger } = await import(`${ENGINE}/engine/ledger.ts`);
const { MIN_PRICE } = await import(`${ENGINE}/engine/money.ts`);
const { Exchange } = await import(`${ENGINE}/engine/orderbook.ts`);
const { finishTime, kickoffTime } = await import(`${ENGINE}/engine/types.ts`);
const { loadSeason } = await import(`${ENGINE}/data/season.ts`);
const bots = await import(`${ENGINE}/sim/bots.ts`);
const { MarketView } = await import(`${ENGINE}/sim/market.ts`);
const { Rng } = await import(`${ENGINE}/sim/rng.ts`);
const { checkpointStats } = await import(`${ENGINE}/sim/report.ts`);

type Cents = number;
const DAY_MS = 24 * 60 * 60 * 1000;
const TREASURY = "tesouraria";
const A = "inflador-A";
const B = "inflador-B";
const F = "fanatico";

const { values } = parseArgs({
  options: {
    lotes: { type: "string", default: "0.1" },
    minimos: { type: "string", default: "0" },
    sementes: { type: "string", default: "10" },
    oferta: { type: "string", default: "3000" },
    margem: { type: "string", default: "0.05" },
    modos: { type: "string", default: "base,pump,fan" },
    tuneis: { type: "string", default: "0" },
    out: { type: "string", default: "resultados.json" },
  },
});

const DATA = new URL("../data", import.meta.url);
const season = loadSeason(fileURLToPath(new URL("brasileirao-2025.json", DATA + "/")));
const cups = [
  ["libertadores", LIBERTADORES],
  ["copa-do-brasil", COPA_DO_BRASIL],
  ["sul-americana", SULAMERICANA],
].map(([name, rules]) => ({ matches: JSON.parse(readFileSync(new URL(`${name}-${season.season}.json`, DATA + "/"), "utf8")).matches, rules }));

// 20 jogadores com os 9 perfis (os três traders com acerto de 30%, 50% e 70%).
const MIX: Record<string, number> = { dividendos: 2, momentum: 2, torcedor: 2, aleatorio: 2, trader: 3, captura: 2, analista: 2, concentrador: 2, antecipador: 3 };
const PROFILES: string[] = bots.PROFILES;
const BUYBACK = 1.5;
const CASH = 10_000_000;

interface RunCfg {
  seed: number;
  lot: number;
  minSide: number;
  pump: boolean;
  /** Um comprador fanático (sem combinar com ninguém) que paga até 3× o valor justo pelo clube-alvo. */
  fan: boolean;
  /** Dupla paciente: sobe o preço só até a beira do túnel, a cada passo da última semana do mês. */
  slow: boolean;
  /** Largura do túnel de preço (0 = sem túnel). */
  tunnel: number;
  offer: number;
  margin: number;
}

function run(cfg: RunCfg) {
  const rng = new Rng(cfg.seed);
  const clubIds: string[] = season.clubs.map((c: any) => c.id);
  const matches = [...season.matches].sort((a: any, b: any) => finishTime(a) - finishTime(b));
  const rules = BRASILEIRAO_A;

  const ledger = new Ledger();
  ledger.open(TREASURY, 0);
  const exchange = new Exchange(ledger, { houseAccounts: [TREASURY], houseTradesSetPrice: true });

  // ---- Túnel de preço com leilão (como o túnel de negociação da B3) ----
  // Um negócio que sairia a mais de `cfg.tunnel` da referência (preço exibido às 0h de
  // Brasília ou o do último leilão) não executa: o clube entra em leilão até a ação dos
  // jogadores no passo seguinte (3 horas). As ordens desse período, inclusive as da casa,
  // e as que já estavam no livro casam num preço só, o de maior volume.
  const STEP_MS = 3 * 60 * 60 * 1000;
  // Negócios entre jogadores, para medir o alerta de reciprocidade (preço exibido antes de cada um).
  const tradeLog: Array<{ t: number; club: string; b: string; s: string; q: number; p: number; prev: number }> = [];
  const shown = new Map<string, number>();
  const logTrade = (club: string, b: string, s: string, q: number, p: number) => {
    if (b !== TREASURY && s !== TREASURY) tradeLog.push({ t: exchange.now, club, b, s, q, p, prev: shown.get(club)! });
    shown.set(club, p);
  };
  const tunnelRef = new Map<string, number>();
  const auctionUntil = new Map<string, number>();
  type AuctionOrder = { id: number; accountId: string; clubId: string; side: "buy" | "sell"; limitPrice: number; quantity: number; seq: number };
  const auctionOrders: AuctionOrder[] = [];
  let auctionSeq = 0;
  let auctions = 0;
  let auctionSteps = 0;
  let auctionTrades = 0;
  const rawPlace = exchange.placeOrder.bind(exchange);
  const rawCancelAll = exchange.cancelAll.bind(exchange);
  const releaseAuction = (o: AuctionOrder) => {
    if (o.side === "buy") ledger.releaseCash(o.accountId, o.quantity * o.limitPrice);
    else ledger.releaseShares(o.accountId, o.clubId, o.quantity);
  };
  const addAuction = (req: any) => {
    if (req.side === "buy") {
      if (req.quantity * req.limitPrice > ledger.availableCash(req.accountId)) return { status: "rejected", trades: [], reason: "saldo insuficiente" };
      ledger.reserveCash(req.accountId, req.quantity * req.limitPrice);
    } else {
      if (req.quantity > ledger.availableShares(req.accountId, req.clubId)) return { status: "rejected", trades: [], reason: "ações insuficientes" };
      ledger.reserveShares(req.accountId, req.clubId, req.quantity);
    }
    const o: AuctionOrder = { id: -++auctionSeq, accountId: req.accountId, clubId: req.clubId, side: req.side, limitPrice: req.limitPrice, quantity: req.quantity, seq: auctionSeq };
    auctionOrders.push(o);
    return { status: "resting", trades: [], order: { ...o, remaining: o.quantity } };
  };
  // A ordem casaria a mais de `cfg.tunnel` da referência?
  const wouldBreak = (req: any, ref: number) => {
    const lo = ref * (1 - cfg.tunnel);
    const hi = ref * (1 + cfg.tunnel);
    const book = exchange.depth(req.clubId);
    let left = req.quantity;
    for (const o of req.side === "buy" ? book.asks : book.bids) {
      if (left <= 0) break;
      if (o.accountId === req.accountId) continue;
      const crosses = req.side === "buy" ? o.limitPrice! <= req.limitPrice : o.limitPrice! >= req.limitPrice;
      if (!crosses) break;
      if (o.limitPrice! < lo || o.limitPrice! > hi) return true;
      left -= o.remaining;
    }
    return false;
  };
  if (cfg.tunnel > 0) {
    (exchange as any).placeOrder = (req: any) => {
      if (auctionUntil.has(req.clubId)) return addAuction(req);
      const ref = tunnelRef.get(req.clubId);
      if (ref !== undefined && req.type === "limit" && wouldBreak(req, ref)) {
        auctionUntil.set(req.clubId, exchange.now + STEP_MS);
        auctions++;
        return addAuction(req);
      }
      return rawPlace(req);
    };
    (exchange as any).cancelAll = (accountId: string, clubId?: string) => {
      let n = rawCancelAll(accountId, clubId);
      for (let i = auctionOrders.length - 1; i >= 0; i--) {
        const o = auctionOrders[i]!;
        if (o.accountId === accountId && (clubId === undefined || o.clubId === clubId)) {
          releaseAuction(o);
          auctionOrders.splice(i, 1);
          n++;
        }
      }
      return n;
    };
  }
  // Fim do leilão: preço único de maior volume (no empate, menor sobra e depois o mais perto da referência).
  function uncross(club: string) {
    auctionUntil.delete(club);
    const book = exchange.depth(club);
    type Row = { kind: "book" | "auction"; id: number; accountId: string; side: "buy" | "sell"; price: number; qty: number; seq: number };
    const rows: Row[] = [
      ...book.bids.map((o: any) => ({ kind: "book" as const, id: o.id, accountId: o.accountId, side: "buy" as const, price: o.limitPrice, qty: o.remaining, seq: o.seq })),
      ...book.asks.map((o: any) => ({ kind: "book" as const, id: o.id, accountId: o.accountId, side: "sell" as const, price: o.limitPrice, qty: o.remaining, seq: o.seq })),
      ...auctionOrders.filter((o) => o.clubId === club).map((o) => ({ kind: "auction" as const, id: o.id, accountId: o.accountId, side: o.side, price: o.limitPrice, qty: o.quantity, seq: 1e9 + o.seq })),
    ];
    const mine = auctionOrders.filter((o) => o.clubId === club);
    for (const o of mine) {
      releaseAuction(o);
      auctionOrders.splice(auctionOrders.indexOf(o), 1);
    }
    const ref = tunnelRef.get(club)!;
    let best: { p: number; vol: number; imb: number } | undefined;
    for (const p of [...new Set(rows.map((r) => r.price))]) {
      const dem = rows.filter((r) => r.side === "buy" && r.price >= p).reduce((s, r) => s + r.qty, 0);
      const sup = rows.filter((r) => r.side === "sell" && r.price <= p).reduce((s, r) => s + r.qty, 0);
      const vol = Math.min(dem, sup);
      const imb = Math.abs(dem - sup);
      if (vol > 0 && (!best || vol > best.vol || (vol === best.vol && (imb < best.imb || (imb === best.imb && Math.abs(p - ref) < Math.abs(best.p - ref)))))) best = { p, vol, imb };
    }
    const left = new Map<Row, number>(rows.map((r) => [r, r.qty]));
    if (best) {
      const P = best.p;
      const buys = rows.filter((r) => r.side === "buy" && r.price >= P).sort((a, b) => b.price - a.price || a.seq - b.seq);
      const sells = rows.filter((r) => r.side === "sell" && r.price <= P).sort((a, b) => a.price - b.price || a.seq - b.seq);
      // Tira do livro as ordens que entram no casamento (devolve as reservas); a sobra volta depois.
      for (const r of [...buys, ...sells]) if (r.kind === "book") exchange.cancelOrder(r.id);
      let i = 0;
      let j = 0;
      let vol = best.vol;
      while (vol > 0 && i < buys.length && j < sells.length) {
        const b = buys[i]!;
        const s = sells[j]!;
        if (b.accountId === s.accountId) {
          j++;
          continue;
        }
        const q = Math.min(left.get(b)!, left.get(s)!, vol);
        ledger.adjustCash(b.accountId, -P * q);
        ledger.adjustShares(b.accountId, club, q);
        ledger.adjustShares(s.accountId, club, -q);
        ledger.adjustCash(s.accountId, P * q);
        left.set(b, left.get(b)! - q);
        left.set(s, left.get(s)! - q);
        vol -= q;
        trades++;
        auctionTrades++;
        logTrade(club, b.accountId, s.accountId, q, P);
        if (b.accountId === TREASURY || s.accountId === TREASURY) houseTrades++;
        if (left.get(b) === 0) i++;
        if (left.get(s) === 0) j++;
      }
      (exchange as any).lastTrade.set(club, P);
      (exchange as any).lastPeerTrade.set(club, P);
      tunnelRef.set(club, P);
      // Sobras das ordens do livro que entraram no casamento.
      for (const r of [...buys, ...sells]) {
        if (r.kind === "book" && left.get(r)! > 0) rawPlace({ accountId: r.accountId, clubId: club, side: r.side, type: "limit", quantity: left.get(r)!, limitPrice: r.price });
      }
    }
    // Ordens do leilão que sobraram vão para o livro.
    for (const r of rows) {
      if (r.kind === "auction" && left.get(r)! > 0) rawPlace({ accountId: r.accountId, clubId: club, side: r.side, type: "limit", quantity: left.get(r)!, limitPrice: r.price });
    }
  }

  // Limite de 20% em volta do preço exibido para jogadores (a casa não passa por ele).
  let rejected = 0;
  class LimitedView extends MarketView {
    override limit(accountId: string, clubId: string, side: "buy" | "sell", quantity: number, price: number): void {
      const ref = this.exchange.price(clubId)!;
      const lo = Math.max(MIN_PRICE, Math.ceil(ref * 0.8));
      const hi = Math.floor(ref * 1.2);
      let p = Math.max(MIN_PRICE, Math.round(price));
      // Fora do limite: o jogador manda no limite quando isso não piora o preço dele; senão, não manda.
      if (side === "buy" && p > hi) p = hi;
      else if (side === "sell" && p < lo) p = lo;
      else if (p < lo || p > hi) {
        rejected++;
        return;
      }
      super.limit(accountId, clubId, side, quantity, p);
    }
    override market(accountId: string, clubId: string, side: "buy" | "sell", quantity: number): void {
      // A mercado só executa dentro dos 20% calculados no envio; a sobra é cancelada.
      const ref = this.exchange.price(clubId)!;
      const bound = side === "buy" ? Math.floor(ref * 1.2) : Math.max(MIN_PRICE, Math.ceil(ref * 0.8));
      const max = side === "buy" ? Math.floor(this.ledger.availableCash(accountId) / bound) : this.ledger.availableShares(accountId, clubId);
      const qty = Math.min(Math.floor(quantity), max);
      if (qty <= 0) return;
      const r = this.exchange.placeOrder({ accountId, clubId, side, type: "limit", quantity: qty, limitPrice: bound });
      if (r.order && r.order.remaining > 0 && this.exchange.getOrder(r.order.id)) this.exchange.cancelOrder(r.order.id);
    }
  }

  const view = new LimitedView(exchange, ledger, clubIds, rules, matches);
  view.buybackMultiple = BUYBACK;
  view.setCups(cups);

  const lastYear = new Map(season.clubs.map((c: any) => [c.id, c.ipoPosition]));
  const players: any[] = [];
  let fanIndex = 0;
  for (const profile of PROFILES) {
    for (let i = 0; i < MIX[profile]!; i++) {
      const id = `${profile}-${String(i + 1).padStart(2, "0")}`;
      const r = new Rng(Math.floor(rng.next() * 2 ** 32));
      players.push(
        profile === "dividendos" ? new bots.DividendBot(id, r)
        : profile === "momentum" ? new bots.MomentumBot(id, r)
        : profile === "torcedor" ? new bots.FanBot(id, r, clubIds[fanIndex++ % clubIds.length]!)
        : profile === "captura" ? new bots.CaptureBot(id, r)
        : profile === "analista" ? new bots.AnalystBot(id, r, lastYear)
        : profile === "concentrador" ? new bots.ConcentratorBot(id, r)
        : profile === "antecipador" ? new bots.AnticipatorBot(id, r)
        : profile === "trader" ? new bots.TraderBot(id, r, [0.3, 0.5, 0.7][i % 3])
        : new bots.RandomBot(id, r),
      );
      ledger.open(id, CASH);
    }
  }
  if (cfg.pump) {
    ledger.open(A, CASH);
    ledger.open(B, CASH);
  }
  if (cfg.fan) ledger.open(F, CASH);

  // ---- IPO ----
  const firstKickoff = Math.min(...matches.map(kickoffTime));
  const ipoAt = firstKickoff - 7 * DAY_MS;
  exchange.setTime(ipoAt);
  view.now = ipoAt;
  const bands = new Map<string, any>(
    season.clubs.map((c: any) => [c.id, priceBand(suggestedPrice(c.ipoPosition) + Math.round(view.cupExpected(c.id) * (1 + BUYBACK)), 0.4)]),
  );
  const bidsByClub = new Map<string, any[]>(clubIds.map((id) => [id, []]));
  for (const p of players) for (const [clubId, bid] of p.ipoBids(view, bands, CASH)) bidsByClub.get(clubId)!.push(bid);

  // Os infladores escolhem o clube mais barato frente ao valor justo (o mais disputado
  // no IPO) e põem nele 60% (A) e 20% (B) do caixa, no teto da faixa.
  // O fanático escolhe o mesmo clube e põe 40% do caixa nele no IPO.
  let target = "";
  if (cfg.pump || cfg.fan) {
    target = clubIds.reduce((best, id) => (view.fairValue(id) / bands.get(id).max > view.fairValue(best) / bands.get(best).max ? id : best));
  }
  if (cfg.pump) {
    const band = bands.get(target);
    bidsByClub.get(target)!.push({ investorId: A, quantity: Math.floor((CASH * 0.6) / band.max), maxPrice: band.max });
    bidsByClub.get(target)!.push({ investorId: B, quantity: Math.floor((CASH * 0.2) / band.max), maxPrice: band.max });
  }
  if (cfg.fan) {
    const band = bands.get(target);
    bidsByClub.get(target)!.push({ investorId: F, quantity: Math.floor((CASH * 0.4) / band.max), maxPrice: band.max });
  }

  const lotShares = Math.floor(cfg.offer * cfg.lot);
  const totalShares = cfg.offer + lotShares;
  const ipo = new Map<string, any>();
  for (const clubId of clubIds) {
    const result = runBookbuilding(cfg.offer, bands.get(clubId), bidsByClub.get(clubId)!);
    ipo.set(clubId, result);
    for (const a of result.allocations) {
      ledger.adjustCash(a.investorId, -a.cost);
      ledger.adjustShares(a.investorId, clubId, a.quantity);
      ledger.adjustCash(TREASURY, a.cost);
    }
    ledger.adjustShares(TREASURY, clubId, result.treasuryShares + lotShares);
    exchange.setReferencePrice(clubId, result.price);
    tunnelRef.set(clubId, result.price);
    shown.set(clubId, result.price);
  }
  const treasuryStartCash = ledger.get(TREASURY).cash;
  const treasuryStartShares = new Map(clubIds.map((id) => [id, ledger.shares(TREASURY, id)]));
  // Clube disputado: demanda no preço de corte maior que a oferta.
  const disputed = clubIds.filter((id) => ipo.get(id).fillRatio < 1);

  // ---- Formador ----
  const qtyFor = (inMatch: boolean) => {
    const pct = Math.floor(totalShares * (inMatch ? 0.0006 : 0.0025));
    // No modo de jogo o mínimo é 1/4 do de fora de jogo, a mesma proporção de 100 e 25 da simulação calibrada.
    const min = inMatch ? Math.round(cfg.minSide / 4) : cfg.minSide;
    return Math.max(1, pct, min);
  };
  function refresh(clubId: string, inMatch: boolean) {
    exchange.cancelAll(TREASURY, clubId);
    const fair = Math.max(MIN_PRICE, view.fairValue(clubId));
    const half = inMatch ? 0.07 : 0.05;
    let bid = Math.max(MIN_PRICE, Math.floor(fair * (1 - half)));
    let ask = Math.max(MIN_PRICE, Math.ceil(fair * (1 + half)));
    const shown = exchange.price(clubId)!;
    // Nunca melhor que o mercado.
    ask = Math.max(ask, Math.ceil(shown * (1 - cfg.margin)));
    bid = Math.max(MIN_PRICE, Math.min(bid, Math.floor(shown * (1 + cfg.margin))));
    if (ask <= bid) ask = bid + 1;
    const q = qtyFor(inMatch);
    const bidQty = Math.min(q, Math.floor(ledger.availableCash(TREASURY) / bid));
    const askQty = Math.min(q, ledger.availableShares(TREASURY, clubId));
    if (bidQty > 0) exchange.placeOrder({ accountId: TREASURY, clubId, side: "buy", type: "limit", quantity: bidQty, limitPrice: bid });
    if (askQty > 0) exchange.placeOrder({ accountId: TREASURY, clubId, side: "sell", type: "limit", quantity: askQty, limitPrice: ask });
  }

  // ---- Temporada ----
  const league = scheduleLeaguePayouts(matches, rules);
  const cupPayouts = cups.flatMap((c) => scheduleCupPayouts(c.matches, c.rules)).filter((p: any) => clubIds.includes(p.clubId));
  const dividends = [...league, ...cupPayouts].sort((a: any, b: any) => a.at - b.at || a.clubId.localeCompare(b.clubId));
  const payouts: any[] = [...dividends, ...scheduleBuyback(dividends, BUYBACK)];
  const closes = [...roundCloseTimes(matches)].sort((a: any, b: any) => a[1] - b[1]);
  const lastPayoutAt = Math.max(...payouts.map((p) => p.at));
  const end = lastPayoutAt + DAY_MS;
  const step = 3 * 60 * 60 * 1000;
  const remainingAfter = (t: number) => {
    const out: Record<string, number> = Object.fromEntries(clubIds.map((id) => [id, 0]));
    for (const p of payouts) if (p.at > t) out[p.clubId] += p.perShare;
    return out;
  };
  const pricesNow = () => Object.fromEntries(clubIds.map((id) => [id, view.price(id)]));
  const checkpoints: any[] = [];
  const exclude = new Set([TREASURY]);

  // Fim de cada mês às 23h59 de Brasília (02h59 UTC do dia 1º seguinte), antes da recompra.
  const monthEnds: number[] = [];
  {
    const d = new Date(ipoAt);
    let y = d.getUTCFullYear();
    let m = d.getUTCMonth();
    for (;;) {
      const t = Date.UTC(y, m + 1, 1, 2, 59);
      if (t >= lastPayoutAt) break;
      if (t > ipoAt + DAY_MS) monthEnds.push(t);
      m++;
      if (m === 12) { m = 0; y++; }
    }
  }

  // Medidas.
  const openAt = ipoAt + DAY_MS;
  const outAt = new Map<string, number>(); // primeiro instante com a tesouraria sem ações do clube
  const stepsEmpty = new Map(clubIds.map((id) => [id, 0]));
  let stepsTotal = 0;
  const ratioSum = new Map(clubIds.map((id) => [id, 0]));
  const ratioMax30 = new Map(clubIds.map((id) => [id, 0]));
  const ratioAt7 = new Map<string, number>();
  let houseTrades = 0;
  let trades = 0;
  exchange.onTrade((t: any) => {
    trades++;
    if (t.buyerId === TREASURY || t.sellerId === TREASURY) houseTrades++;
    logTrade(t.clubId, t.buyerId, t.sellerId, t.quantity, t.price);
  });
  const pumps: any[] = [];
  let slowAcc: any;
  let fanFromHouse = 0;
  let fanMax = 0;
  let fanSum = 0;
  let fanSteps = 0;
  let fanStop: number | undefined;
  let fanAfter: number | undefined;

  let payoutIdx = 0;
  let matchIdx = 0;
  let closeIdx = 0;
  let monthIdx = 0;
  let lastDay = Math.floor(ipoAt / DAY_MS);
  const pendingAfter: Array<{ at: number; rec: any }> = [];

  let lastDayBRT = Math.floor((openAt - 3 * 60 * 60 * 1000) / DAY_MS);
  for (let t = openAt; t <= end; t += step) {
    exchange.setTime(t);
    view.now = t;
    // Referência do túnel: o preço exibido às 0h de Brasília (o clube em leilão mantém a dele).
    const dayBRT = Math.floor((t - 3 * 60 * 60 * 1000) / DAY_MS);
    if (dayBRT !== lastDayBRT) {
      lastDayBRT = dayBRT;
      for (const id of clubIds) if (!auctionUntil.has(id)) tunnelRef.set(id, exchange.price(id)!);
    }
    while (payoutIdx < payouts.length && payouts[payoutIdx].at <= t) {
      const p = payouts[payoutIdx++];
      if (p.kind === "buyback") {
        auctionUntil.delete(p.clubId);
        for (const account of ledger.all()) exchange.cancelAll(account.id, p.clubId);
        applyBuyback(ledger, p, exclude);
        continue;
      }
      applyPayout(ledger, p, exclude);
      if (p.kind === "points") view.paidPoints.set(p.clubId, view.paidPoints.get(p.clubId)! + p.perShare / rules.perPoint);
      else if (p.kind === "placement") view.placementPaid = true;
      else view.cupPaid.set(p.clubId, (view.cupPaid.get(p.clubId) ?? 0) + p.perShare);
    }
    let advanced = false;
    while (matchIdx < matches.length && finishTime(matches[matchIdx]) <= t) {
      matchIdx++;
      advanced = true;
    }
    if (advanced) view.setKnownMatches(matches.slice(0, matchIdx).filter((m: any) => m.status === "finished"));
    while (closeIdx < closes.length && closes[closeIdx][1] <= t) {
      const [round, at] = closes[closeIdx++];
      checkpoints.push({ label: `Rodada ${round}`, at, prices: pricesNow(), remainingDividends: remainingAfter(at) });
    }
    const inMatch = new Set<string>();
    for (const m of matches) {
      if (kickoffTime(m) <= t && t < finishTime(m)) {
        inMatch.add(m.home);
        inMatch.add(m.away);
      }
    }
    if (payoutIdx < payouts.length) for (const clubId of clubIds) refresh(clubId, inMatch.has(clubId));
    for (const p of rng.shuffle([...players])) if (rng.chance(0.25)) p.act(view);

    // Infladores. A dupla apressada age só no último passo antes do fim do mês, depois de
    // todos. A paciente age a cada passo da última semana do mês, sem passar da beira do túnel.
    if (cfg.pump && monthIdx < monthEnds.length) {
      const monthEnd = monthEnds[monthIdx]!;
      if (cfg.slow && t >= monthEnd - 7 * DAY_MS) {
        const r = pump(target, t, 0.1);
        if (!slowAcc) slowAcc = { ...r, steps: 0, premium: 0, fromHouse: 0, auctionHit: false };
        slowAcc.steps += r.steps;
        slowAcc.premium += r.premium;
        slowAcc.fromHouse += r.fromHouse;
        slowAcc.auctionHit ||= r.auctionHit;
      }
      if (t + step > monthEnd) {
        // A foto do fim do mês sai antes do fim de qualquer leilão aberto agora.
        const rec = cfg.slow
          ? { ...slowAcc, t, after: view.price(target), paperGain: view.netWorth(A) + view.netWorth(B) - slowAcc.worthBefore }
          : pump(target, t, 0.5);
        pumps.push(rec);
        pendingAfter.push({ at: t + DAY_MS, rec });
        slowAcc = undefined;
        monthIdx++;
      }
    }
    // Fanático: a cada passo, compra até R$ 3 mil do alvo no maior preço que o limite deixa,
    // até 3× o valor justo e até ter 80% do patrimônio inicial investido nele.
    if (cfg.fan && payoutIdx < payouts.length) {
      exchange.cancelAll(F, target);
      const P = exchange.price(target)!;
      const fair = Math.max(MIN_PRICE, view.fairValue(target));
      const limit = Math.min(Math.floor(P * 1.2), Math.floor(3 * fair));
      if (limit >= MIN_PRICE && ledger.get(F).cash > CASH * 0.2) {
        const qty = Math.floor(Math.min(50_000, ledger.availableCash(F)) / limit);
        if (qty > 0) {
          const r = exchange.placeOrder({ accountId: F, clubId: target, side: "buy", type: "limit", quantity: qty, limitPrice: limit });
          for (const tr of r.trades) if (tr.sellerId === TREASURY) fanFromHouse += tr.quantity;
        }
      }
    }
    // Medidas do fanático: enquanto ele compra e 30 dias depois de ele parar.
    if (cfg.fan && payoutIdx < payouts.length) {
      const ratio = view.price(target) / Math.max(MIN_PRICE, view.fairValue(target));
      if (fanStop === undefined) {
        fanMax = Math.max(fanMax, ratio);
        fanSum += ratio;
        fanSteps++;
        if (ledger.get(F).cash <= CASH * 0.2) fanStop = t;
      } else if (fanAfter === undefined && t >= fanStop + 30 * DAY_MS) fanAfter = ratio;
    }
    for (const pa of pendingAfter.filter((x) => x.at <= t && x.rec.priceAfterDay === undefined)) pa.rec.priceAfterDay = view.price(target);

    // Leilões que terminam neste passo, depois de todos agirem.
    auctionSteps += auctionUntil.size;
    for (const [club, until] of [...auctionUntil]) if (until <= t) uncross(club);

    // Medidas por passo (até a recompra).
    if (payoutIdx < payouts.length) {
      stepsTotal++;
      for (const id of clubIds) {
        const sh = ledger.shares(TREASURY, id);
        if (sh === 0) {
          stepsEmpty.set(id, stepsEmpty.get(id)! + 1);
          if (!outAt.has(id)) outAt.set(id, t);
        }
        const ratio = view.price(id) / Math.max(MIN_PRICE, view.fairValue(id));
        ratioSum.set(id, ratioSum.get(id)! + ratio);
        if (t - openAt <= 30 * DAY_MS) ratioMax30.set(id, Math.max(ratioMax30.get(id)!, ratio));
        if (!ratioAt7.has(id) && t - openAt >= 7 * DAY_MS) ratioAt7.set(id, ratio);
      }
    }
    const day = Math.floor(t / DAY_MS);
    if (day !== lastDay) {
      lastDay = day;
      for (const clubId of clubIds) view.history.get(clubId)!.push(view.price(clubId));
    }
  }

  function pump(club: string, t: number, budgetFraction: number) {
    const worth = () => view.netWorth(A) + view.netWorth(B);
    const before = view.price(club);
    const worthBefore = worth();
    const fair = view.fairValue(club);
    let budget = ledger.availableCash(A) * budgetFraction;
    let steps = 0;
    let premium = 0; // quanto A pagou acima do valor justo a terceiros (casa e jogadores)
    let fromHouse = 0;
    let auctionHit = false;
    exchange.cancelAll(A);
    exchange.cancelAll(B);
    for (let i = 0; i < 40; i++) {
      if (auctionUntil.has(club)) break;
      const P = exchange.price(club)!;
      let hi = Math.floor(P * 1.2);
      // A dupla paciente não passa da beira do túnel, para não abrir leilão.
      if (cfg.slow && cfg.tunnel > 0) hi = Math.min(hi, Math.floor(tunnelRef.get(club)! * (1 + cfg.tunnel)));
      if (hi <= P || ledger.availableShares(B, club) < 1) break;
      const others = exchange.depth(club).asks.filter((o: any) => o.accountId !== B && o.limitPrice <= hi);
      const qtyBelow = others.reduce((s: number, o: any) => s + o.remaining, 0);
      const costBelow = others.reduce((s: number, o: any) => s + o.remaining * o.limitPrice, 0);
      if (costBelow + hi > budget) break;
      exchange.placeOrder({ accountId: B, clubId: club, side: "sell", type: "limit", quantity: 1, limitPrice: hi });
      const r = exchange.placeOrder({ accountId: A, clubId: club, side: "buy", type: "limit", quantity: qtyBelow + 1, limitPrice: hi });
      for (const tr of r.trades) {
        budget -= tr.price * tr.quantity;
        if (tr.sellerId !== B) premium += (tr.price - fair) * tr.quantity;
        if (tr.sellerId === TREASURY) fromHouse += tr.quantity;
      }
      // Abriu leilão: as ordens da dupla ficam nele.
      if (auctionUntil.has(club)) {
        auctionHit = true;
        break;
      }
      exchange.cancelAll(A);
      exchange.cancelAll(B);
      if (exchange.price(club) !== hi) break;
      steps++;
    }
    return {
      t,
      before,
      fair,
      after: view.price(club),
      steps,
      paperGain: worth() - worthBefore,
      worthBefore,
      premium,
      fromHouse,
      auctionHit,
    };
  }

  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
  const corr = checkpoints.filter((c) => Number(/\d+/.exec(c.label)![0]) <= 37).map((c) => checkpointStats(c).correlation);
  const retorno: Record<string, number> = {};
  for (const p of PROFILES) {
    const g = players.filter((b) => b.profile === p);
    retorno[p] = sum(g.map((b) => view.netWorth(b.id))) / g.length / CASH - 1;
  }
  const days = (ms: number) => ms / DAY_MS;
  // Alerta de reciprocidade: por par de contas e clube, o maior número de negócios entre
  // os dois em 7 dias seguidos, de todos e só dos suspeitos (até `maxQ` ações e mexendo o
  // preço exibido `move` ou mais). Separa a dupla dos pares de jogadores normais.
  const pairs = new Map<string, typeof tradeLog>();
  for (const tr of tradeLog) {
    const k = `${[tr.b, tr.s].sort().join("|")}|${tr.club}`;
    if (!pairs.has(k)) pairs.set(k, []);
    pairs.get(k)!.push(tr);
  }
  const max7d = (xs: typeof tradeLog) => {
    let best = 0;
    for (let i = 0, j = 0; i < xs.length; i++) {
      while (xs[i]!.t - xs[j]!.t > 7 * DAY_MS) j++;
      best = Math.max(best, i - j + 1);
    }
    return best;
  };
  const suspicious = (maxQ: number, move: number) => (tr: (typeof tradeLog)[number]) => tr.q <= maxQ && Math.abs(tr.p / tr.prev - 1) >= move;
  const pairStats = [...pairs].map(([k, xs]) => ({
    dupla: k.startsWith(`${A}|${B}|`),
    all: max7d(xs),
    s10_5: max7d(xs.filter(suspicious(10, 0.05))),
    s10_3: max7d(xs.filter(suspicious(10, 0.03))),
    s50_5: max7d(xs.filter(suspicious(50, 0.05))),
  }));
  const club = (id: string) => ({
    id,
    fill: ipo.get(id).fillRatio,
    startShares: treasuryStartShares.get(id)!,
    outDay: outAt.has(id) ? days(outAt.get(id)! - openAt) : null,
    emptyShare: stepsEmpty.get(id)! / stepsTotal,
    ratioMean: ratioSum.get(id)! / stepsTotal,
    ratioMax30: ratioMax30.get(id)!,
    ratioAt7: ratioAt7.get(id)!,
  });
  return {
    cfg,
    disputed,
    target,
    clubs: clubIds.map(club),
    corrMean: sum(corr) / corr.length,
    retorno,
    houseResult: ledger.get(TREASURY).cash - treasuryStartCash,
    treasuryStartCash,
    trades,
    houseTrades,
    rejected,
    auctions,
    auctionSteps,
    auctionTrades,
    pairStats,
    pumps,
    colluders: cfg.pump ? (view.netWorth(A) + view.netWorth(B)) / (2 * CASH) - 1 : null,
    fan: cfg.fan
      ? {
          max: fanMax,
          mean: fanSum / fanSteps,
          days: fanStop === undefined ? null : days(fanStop - openAt),
          after: fanAfter ?? null,
          fromHouse: fanFromHouse,
          final: view.netWorth(F) / CASH - 1,
        }
      : null,
  };
}

const lotes = values.lotes!.split(",").map(Number);
const minimos = values.minimos!.split(",").map(Number);
const n = Number(values.sementes);
const out: any[] = [];
const t0 = Date.now();
const tuneis = values.tuneis!.split(",").map(Number);
for (const lot of lotes)
  for (const minSide of minimos)
    for (const tunnel of tuneis)
      for (const mode of values.modos!.split(","))
        for (let seed = 1; seed <= n; seed++) {
          out.push(run({ seed, lot, minSide, tunnel, pump: mode === "pump" || mode === "slow", slow: mode === "slow", fan: mode === "fan", offer: Number(values.oferta), margin: Number(values.margem) }));
          process.stderr.write(".");
        }
writeFileSync(values.out!, JSON.stringify(out));
console.error(`\n${out.length} simulações em ${((Date.now() - t0) / 1000).toFixed(0)} s -> ${values.out}`);
