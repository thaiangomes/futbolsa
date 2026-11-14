import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../src/infra/db/client.js";
import { lockWallets } from "../src/infra/db/locks.js";
import { authIdentities, clubs, ipoAllocations, ipoBids, ipoResults, seasonClubs, seasons, users, wallets } from "../src/infra/db/schema/index.js";
import { seed } from "../src/infra/db/seed.js";
import { withTransaction } from "../src/infra/db/transaction.js";
import { openWallet, postMany, type Movement } from "../src/modules/portfolio/ledger/index.js";
import { INICIO_DA_CARGA } from "./servidor.js";

/**
 * A população da carga (T16): a temporada em pregão, os clubes listados, a tesouraria com ações e caixa e N jogadores
 * com carteira. As linhas de usuário, identidade e carteira entram em lote (um `INSERT` por mil); o extrato e as posições
 * passam pelo livro-razão de verdade (`postMany`), para o verificador de invariantes valer no fim.
 *
 * O dinheiro segue a liquidação do IPO (`settlement.service.ts`): cada jogador paga as ações do clube (`ipo_settle`,
 * caixa para baixo) e a tesouraria recebe a soma (uma linha `ipo_settle` só com o caixa), mais as ações que sobram para a
 * casa cotar (linha sem caixa).
 */

export interface OpcoesPopulacao {
  /** Quantos clubes listar (os primeiros do seed, em ordem de ticker). */
  clubes: number;
  jogadores: number;
  /** Ações de cada clube que cada jogador recebe no começo. */
  acoesPorClube?: number;
  /** Ações de cada clube na tesouraria, para a casa cotar. */
  acoesDaCasa?: number;
  /** Preço de corte do IPO, em centavos (R$ 40,00). */
  preco?: number;
  /** Caixa inicial de cada jogador (R$ 100.000,00). */
  caixa?: number;
}

export interface Jogador {
  /** O `sub` da identidade: o gerador pede o token por ele. */
  subject: string;
  userId: string;
  walletId: number;
}

export interface Mundo {
  seasonId: number;
  tickers: string[];
  clubIds: Map<string, number>;
  treasuryWalletId: number;
  preco: number;
}

const TAMANHO_DO_LOTE = 1000;

/** A temporada de 2027 em pregão, com os `clubes` primeiros clubes listados a R$ 40,00 e a tesouraria aberta. */
export async function prepararMundo(db: Database, o: Pick<OpcoesPopulacao, "clubes" | "preco" | "acoesDaCasa">): Promise<Mundo> {
  const preco = o.preco ?? 4000;
  await seed(db, 2027);
  const [season] = await db.select().from(seasons).where(eq(seasons.year, 2027));
  const todos = await db.select({ id: clubs.id, ticker: clubs.ticker }).from(clubs).orderBy(clubs.ticker);
  const escolhidos = todos.filter((c) => c.ticker !== null).slice(0, o.clubes);
  if (escolhidos.length < o.clubes) throw new Error(`o seed só tem ${escolhidos.length} clubes (pediu ${o.clubes})`);
  const seasonId = season!.id;
  const diaBrasilia = new Date("2027-04-06T00:00:00-03:00");
  await db.insert(seasonClubs).values(
    escolhidos.map((c) => ({ seasonId, clubId: c.id, division: "A", totalShares: 0, lastPrice: preco, ipoPrice: preco, tunnelRef: preco, tunnelRefDay: diaBrasilia })),
  );
  await db
    .update(seasons)
    .set({ status: "trading", tradingOpensAt: new Date("2027-04-05T13:00:00Z") })
    .where(eq(seasons.id, seasonId));
  const treasury = await withTransaction(db, (tx) =>
    openWallet(tx, { seasonId, owner: { type: "treasury" }, at: INICIO_DA_CARGA, initialCash: 0 }),
  );
  return {
    seasonId,
    tickers: escolhidos.map((c) => c.ticker!),
    clubIds: new Map(escolhidos.map((c) => [c.ticker!, c.id])),
    treasuryWalletId: treasury.id,
    preco,
  };
}

/**
 * Cria os jogadores e entrega as ações iniciais. Devolve a lista, na ordem de criação. A tesouraria ganha, por clube, as
 * ações da casa e o caixa pago pelos jogadores.
 */
export async function criarJogadores(db: Database, mundo: Mundo, o: OpcoesPopulacao, progresso?: (feitos: number) => void): Promise<Jogador[]> {
  const caixa = o.caixa ?? 10_000_000;
  const acoes = o.acoesPorClube ?? 50;
  const acoesDaCasa = o.acoesDaCasa ?? 20_000;
  const resultado: Jogador[] = [];
  const agora = INICIO_DA_CARGA;

  for (let inicio = 0; inicio < o.jogadores; inicio += TAMANHO_DO_LOTE) {
    const quantos = Math.min(TAMANHO_DO_LOTE, o.jogadores - inicio);
    const lote = Array.from({ length: quantos }, (_, i) => {
      const subject = randomUUID();
      const n = inicio + i;
      return { subject, n, email: `${subject}@exemplo.com` };
    });
    const novos = await db
      .insert(users)
      .values(lote.map((j) => ({ email: j.email, nickname: `c_${j.n}_${j.subject.slice(0, 6)}`, termsAcceptedAt: new Date("2027-03-20T12:00:00Z") })))
      .returning({ id: users.id, email: users.email });
    const porEmail = new Map(novos.map((u) => [u.email!, u.id]));
    await db.insert(authIdentities).values(lote.map((j) => ({ provider: "supabase", subject: j.subject, userId: porEmail.get(j.email)! })));
    const carteiras = await db
      .insert(wallets)
      .values(lote.map((j) => ({ seasonId: mundo.seasonId, ownerType: "user", userId: porEmail.get(j.email)!, enteredAt: agora, entryMode: "ipo" })))
      .returning({ id: wallets.id, userId: wallets.userId });
    const carteiraDe = new Map(carteiras.map((w) => [w.userId!, w.id]));
    for (const j of lote) resultado.push({ subject: j.subject, userId: porEmail.get(j.email)!, walletId: carteiraDe.get(porEmail.get(j.email)!)! });
    progresso?.(resultado.length);
  }

  // o extrato e as posições passam pelo livro-razão, em lotes de 50 carteiras por transação
  const gasto = acoes * mundo.preco;
  for (let inicio = 0; inicio < resultado.length; inicio += 50) {
    const grupo = resultado.slice(inicio, inicio + 50);
    await withTransaction(db, async (tx) => {
      await lockWallets(tx, grupo.map((j) => j.walletId));
      for (const j of grupo) {
        const movimentos: Movement[] = [{ walletId: j.walletId, at: agora, kind: "initial", cashDelta: caixa }];
        for (const ticker of mundo.tickers) {
          movimentos.push({
            walletId: j.walletId,
            at: agora,
            kind: "ipo_settle",
            clubId: mundo.clubIds.get(ticker)!,
            cashDelta: -gasto,
            sharesDelta: acoes,
            price: mundo.preco,
            costBasis: "purchase",
            ref: { type: "ipo_result", id: mundo.clubIds.get(ticker)! },
          });
        }
        await postMany(tx, movimentos);
      }
    });
  }

  // a tesouraria recebe o que os jogadores pagaram e as ações da casa; o `adjustment` dá caixa para a casa comprar
  await withTransaction(db, async (tx) => {
    await lockWallets(tx, [mundo.treasuryWalletId]);
    const movimentos: Movement[] = [{ walletId: mundo.treasuryWalletId, at: agora, kind: "adjustment", cashDelta: 100_000_000_000, reason: "caixa da carga" }];
    for (const ticker of mundo.tickers) {
      const clubId = mundo.clubIds.get(ticker)!;
      const ref = { type: "ipo_result", id: clubId };
      movimentos.push({ walletId: mundo.treasuryWalletId, at: agora, kind: "ipo_settle", clubId, cashDelta: gasto * resultado.length, ref });
      movimentos.push({ walletId: mundo.treasuryWalletId, at: agora, kind: "ipo_settle", clubId, sharesDelta: acoesDaCasa, price: mundo.preco, costBasis: "purchase", ref });
    }
    await postMany(tx, movimentos);
  });

  // o registro do IPO (oferta, alocação e resultado de cada clube), para a invariante "ações do clube = oferta + lote + emitidas"
  await db.update(seasons).set({ offerSize: acoes * resultado.length }).where(eq(seasons.id, mundo.seasonId));
  for (const ticker of mundo.tickers) {
    const clubId = mundo.clubIds.get(ticker)!;
    for (let inicio = 0; inicio < resultado.length; inicio += TAMANHO_DO_LOTE) {
      const grupo = resultado.slice(inicio, inicio + TAMANHO_DO_LOTE);
      const ofertas = await db
        .insert(ipoBids)
        .values(grupo.map((j) => ({ seasonId: mundo.seasonId, clubId, walletId: j.walletId, quantity: acoes, maxPrice: mundo.preco, reserved: 0, status: "settled", createdAt: agora, updatedAt: agora })))
        .returning({ id: ipoBids.id });
      await db.insert(ipoAllocations).values(ofertas.map((b) => ({ bidId: b.id, shares: acoes, paid: gasto, refunded: 0 })));
    }
    await db.insert(ipoResults).values({ seasonId: mundo.seasonId, clubId, cutPrice: mundo.preco, demandAtCut: acoes * resultado.length, allocationNum: 1, allocationDen: 1, treasuryShares: 0, mmLotShares: acoesDaCasa, settledAt: agora });
  }

  // o total de ações de cada clube é a soma das posições (a invariante de ações confere)
  await db.execute(sql`update futbolsa.season_clubs sc set total_shares = coalesce((select sum(p.shares) from futbolsa.positions p
    join futbolsa.wallets w on w.id = p.wallet_id where w.season_id = sc.season_id and p.club_id = sc.club_id), 0)
    where sc.season_id = ${mundo.seasonId}`);
  await db.update(seasonClubs).set({ lastTradeAt: null }).where(and(eq(seasonClubs.seasonId, mundo.seasonId)));
  return resultado;
}
