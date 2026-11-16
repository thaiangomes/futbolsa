import { and, eq } from "drizzle-orm";
import { AUCTION_DURATION_MS, dayStart, rollTunnelReference, type Cents } from "@futbolsa/engine";
import type { LockedClub, Tx } from "../../../infra/db/index.js";
import { seasonClubs } from "../../../infra/db/schema/index.js";
import { displayedPriceOf, lastTradeUntil, referencePriceOf } from "./displayed-price.js";

/**
 * O estado do túnel de preço e do leilão de um clube (Livro de ofertas e formador de mercado, "Túnel de preço e
 * leilão"; Plano do livro de ofertas e formador, "Túnel e leilão"). Tudo mora em quatro colunas da linha do clube,
 * a mesma que o motor de ordens trava:
 *
 * | Estado                       | `auction_opened_at` | `auction_until` |
 * |------------------------------|---------------------|-----------------|
 * | Normal                       | vazio               | vazio           |
 * | Em leilão                    | preenchido          | no futuro       |
 * | Leilão vencido               | preenchido          | no passado      |
 * | Leilão parado pela suspensão | preenchido          | vazio           |
 *
 * e a referência do túnel em `tunnel_ref` e `tunnel_ref_day`. As contas são do motor (`tunnel.ts`); aqui se lê a
 * linha travada e se grava, sempre com o clube travado na transação de quem chama.
 */

/** As colunas do leilão, como vêm na linha que o `lockClubs` devolve. */
export interface AuctionColumns {
  auctionOpenedAt: Date | null;
  auctionUntil: Date | null;
}

/**
 * O clube está em leilão: aberto, vencido ainda não fechado ou parado pela suspensão. Nenhum negócio sai e a
 * referência do túnel não vira. Para a linha travada (a anulação de negócios da F14 recusa com `club_in_auction`).
 */
export function isInAuction(club: AuctionColumns): boolean {
  return club.auctionOpenedAt !== null;
}

/**
 * O leilão venceu e ainda não foi fechado: tem fim marcado e o fim já chegou (às 15h40 em ponto o leilão das 12h40
 * acabou). Parado pela suspensão (sem fim marcado), não vence.
 */
export function auctionExpired(club: AuctionColumns, now: Date): boolean {
  return club.auctionOpenedAt !== null && club.auctionUntil !== null && club.auctionUntil.getTime() <= now.getTime();
}

/** O leilão do clube como as respostas e os eventos o mostram (P11): `until` vazio enquanto parado; nulo fora de leilão. */
export function auctionOf(club: AuctionColumns): { until: Date | null } | null {
  return isInAuction(club) ? { until: club.auctionUntil } : null;
}

const clubRow = (club: { seasonId: number; clubId: number }) => and(eq(seasonClubs.seasonId, club.seasonId), eq(seasonClubs.clubId, club.clubId));

function assertLocked(tx: Tx, club: LockedClub): void {
  if (!tx.locks.isClubLocked(club.ticker)) throw new Error(`o clube ${club.ticker} não está travado nesta transação`);
}

/**
 * A referência do túnel para agora, com o clube travado (P9): no primeiro uso de um dia novo de Brasília ela vira o
 * preço exibido (nenhum negócio saiu antes de ela virar, então o preço lido agora é o das 0h) e é gravada; o clube em
 * leilão mantém a que tinha (critério 44). Na estreia, é o preço de corte do IPO. Sem tarefa às 0h: toda transação
 * que pode executar (ordem, reposição, fim do leilão) passa por aqui.
 */
export async function rollTunnel(tx: Tx, club: LockedClub, now: Date): Promise<Cents> {
  assertLocked(tx, club);
  const rolled = rollTunnelReference(
    { reference: club.tunnelRef, referenceDay: club.tunnelRefDay?.getTime() ?? null, inAuction: isInAuction(club) },
    referencePriceOf(club),
    now.getTime(),
  );
  if (rolled.changed) {
    await tx.db
      .update(seasonClubs)
      .set({ tunnelRef: rolled.reference, tunnelRefDay: new Date(rolled.referenceDay) })
      .where(clubRow(club));
  }
  return rolled.reference;
}

/**
 * Abre o leilão do clube: começa agora e dura 3 horas (`AUCTION_DURATION_MS`), sem prorrogação. Devolve o fim. Quem
 * chama já conferiu, com o clube travado, que ele não estava em leilão.
 */
export async function openAuction(tx: Tx, club: LockedClub, at: Date): Promise<Date> {
  assertLocked(tx, club);
  if (isInAuction(club)) throw new Error(`o clube ${club.ticker} já está em leilão`);
  const until = new Date(at.getTime() + AUCTION_DURATION_MS);
  await tx.db.update(seasonClubs).set({ auctionOpenedAt: at, auctionUntil: until }).where(clubRow(club));
  return until;
}

/**
 * Encerra o leilão do clube travado: limpa as duas colunas do leilão e grava a referência do túnel com o dia de
 * Brasília de `at`. Com negócio, a referência é o preço único; sem negócio, a mesma de antes, e o dia de hoje faz
 * ela valer até as 0h seguintes mesmo quando o leilão atravessou a meia-noite (D4). Devolve a referência gravada.
 */
export async function endAuction(tx: Tx, club: LockedClub, reference: Cents, at: Date): Promise<Cents> {
  assertLocked(tx, club);
  if (!isInAuction(club)) throw new Error(`o clube ${club.ticker} não está em leilão`);
  await tx.db
    .update(seasonClubs)
    .set({ auctionOpenedAt: null, auctionUntil: null, tunnelRef: reference, tunnelRefDay: new Date(dayStart(at.getTime())) })
    .where(clubRow(club));
  return reference;
}

/** O leilão está parado pela suspensão: tem início e não tem fim marcado (D5, critério 45). */
export function isAuctionPaused(club: AuctionColumns): boolean {
  return club.auctionOpenedAt !== null && club.auctionUntil === null;
}

/**
 * Para a contagem do leilão do clube travado na suspensão (do clube ou do mercado todo; critério 45 e D5): limpa
 * `auction_until` e mantém o início, que é o estado "leilão parado pela suspensão". Nada executa enquanto ele está
 * parado, e o fim do leilão não o fecha (`closeAuction` devolve `paused`). Devolve se parou: fora de leilão, já parado
 * ou já vencido, não faz nada. O vencido terminou antes da suspensão: ele fecha na retomada, com o horário dela (P10),
 * em vez de ganhar 3 horas a mais.
 */
export async function pauseAuction(tx: Tx, club: LockedClub, at: Date): Promise<boolean> {
  assertLocked(tx, club);
  if (!isInAuction(club) || club.auctionUntil === null || auctionExpired(club, at)) return false;
  await tx.db.update(seasonClubs).set({ auctionUntil: null }).where(clubRow(club));
  return true;
}

/**
 * Recomeça o leilão parado do clube travado: `auction_until` = `at` + 3 horas (`AUCTION_DURATION_MS`), contadas de novo
 * desde a retomada (critério 45: parado às 14h e retomado às 16h, termina às 19h). Quem chama já conferiu que não sobra
 * suspensão do clube nem do mercado (D5). Devolve o fim novo, ou nulo quando o leilão não estava parado.
 */
export async function restartAuction(tx: Tx, club: LockedClub, at: Date): Promise<Date | null> {
  assertLocked(tx, club);
  if (!isAuctionPaused(club)) return null;
  const until = new Date(at.getTime() + AUCTION_DURATION_MS);
  await tx.db.update(seasonClubs).set({ auctionUntil: until }).where(clubRow(club));
  return until;
}

/**
 * Encerra o leilão do clube travado sem casar (fim da negociação, L7): limpa as duas colunas do leilão e não mexe na
 * referência do túnel nem no preço. As ordens do leilão são canceladas na mesma transação. Devolve se havia leilão.
 */
export async function dropAuction(tx: Tx, club: LockedClub): Promise<boolean> {
  assertLocked(tx, club);
  if (!isInAuction(club)) return false;
  await tx.db.update(seasonClubs).set({ auctionOpenedAt: null, auctionUntil: null }).where(clubRow(club));
  return true;
}

/**
 * Refaz a referência do túnel depois de uma anulação de negócios (pedido da F14, Admin, critérios 39 a 45): o preço
 * do último leilão de hoje ou, sem leilão hoje, o preço exibido às 0h de Brasília; grava `tunnel_ref` e
 * `tunnel_ref_day` e devolve a referência. Os negócios são lidos por `lastTradeUntil`, o ponto único em que a F14
 * acrescenta o filtro dos anulados: refazer depois de anular já dá a referência sem eles.
 *
 * Com o clube travado e fora de leilão: em leilão a referência não muda (critério 44), e a anulação é recusada antes
 * (`isInAuction`).
 */
export async function rebuildTunnelReference(tx: Tx, club: LockedClub, now: Date): Promise<Cents> {
  assertLocked(tx, club);
  if (isInAuction(club)) throw new Error(`o clube ${club.ticker} está em leilão: a referência do túnel não muda até ele acabar`);
  const today = new Date(dayStart(now.getTime()));
  const auction = await lastTradeUntil(tx.db, club.clubId, now, { since: today, inAuction: true });
  const atMidnight = auction ? null : await lastTradeUntil(tx.db, club.clubId, today);
  // antes do primeiro negócio do clube, o preço exibido é o do IPO
  const reference = auction?.price ?? atMidnight?.price ?? displayedPriceOf({ lastPrice: null, ipoPrice: club.ipoPrice ?? club.lastPrice });
  await tx.db.update(seasonClubs).set({ tunnelRef: reference, tunnelRefDay: today }).where(clubRow(club));
  return reference;
}

/**
 * Quem fecha um leilão vencido (P10 do plano). A ordem, o cancelamento e a reposição que encontram o leilão vencido
 * saem da transação sem gravar nada, chamam `closeAuction` (que roda numa transação própria e é repetível: leilão já
 * fechado não faz nada) e tentam de novo. Classe abstrata para servir de chave de injeção: o `MarketModule` a liga ao
 * `CloseAuctionService` (`auction/close-auction.ts`, L5) pelo `CloseAuctionAdapter`; sem registro, quem depende
 * deste ponto o recebe vazio (os testes que montam os serviços à mão).
 */
export abstract class AuctionCloser {
  abstract closeAuction(seasonId: number, ticker: string, now: Date): Promise<void>;
}
