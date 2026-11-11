import "reflect-metadata";
import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/infra/db/client.js";
import { withTransaction } from "../../src/infra/db/index.js";
import { trades } from "../../src/infra/db/schema/index.js";
import { CancelService, type CancelOrderResult, type OrderService, type PlaceOrderResult } from "../../src/modules/market/index.js";
import { PortfolioLedger } from "../../src/modules/portfolio/index.js";
import { useTestDatabase } from "../support/db.js";
import { openPlayerWallets, sleep } from "../support/fixtures.js";
import { totalCash } from "../support/invariants.js";
import { marketSeason } from "./helpers.js";
import {
  accepted,
  assertMarketInvariants,
  barrier,
  giveShares,
  openTreasury,
  orderInputs,
  orderRow,
  orderService,
  positionOf,
  syncTotalShares,
  walletOf,
} from "./order-helpers.js";

// T6 do Plano do livro de ofertas e formador, "Concorrente": a compra de Bruno chega enquanto Ana cancela a venda
// que ele alcançaria, cada uma na transação e na conexão dela, com uma barreira para elas se cruzarem. Ou sai o
// negócio e o cancelamento devolve só a sobra (ou dá `order_not_open`), ou o cancelamento vence e não há negócio;
// nunca os dois. 50 repetições.

const ROUNDS = 50;
const NOW = new Date("2027-04-06T13:05:00Z");
const RICH = 10_000_000;
const PRICE = 4000;

describe("ordem e cancelamento ao mesmo tempo, contra o Postgres", () => {
  const t = useTestDatabase(12);
  let db: Database;
  let seasonId: number;
  let fla3: number;
  let service: OrderService;
  let cancels: CancelService;
  let o: ReturnType<typeof orderInputs>;
  let anas: number[];
  let brunos: number[];
  let cashBefore: number;
  let retries = 0;
  const transaction = { onRetry: () => retries++ };

  beforeAll(async () => {
    db = t.db;
    const season = await marketSeason(db, { tickers: ["FLA3"] });
    seasonId = season.seasonId;
    fla3 = season.clubIds.get("FLA3")!;
    await openTreasury(db, seasonId);
    ({ service } = orderService(db));
    cancels = new CancelService(db, new PortfolioLedger());
    o = orderInputs({ seasonId, now: NOW });
    anas = await openPlayerWallets(db, seasonId, ROUNDS, RICH);
    brunos = await openPlayerWallets(db, seasonId, ROUNDS, RICH);
    for (const ana of anas) await giveShares(db, ana, fla3, 10);
    await syncTotalShares(db, seasonId);
    cashBefore = await totalCash(db, seasonId);
  });

  it("a compra de Bruno e o cancelamento de Ana: um negócio ou um cancelamento, nunca os dois; reservas certas (50 repetições)", async () => {
    const outcomes = { tradeFirst: 0, cancelFirst: 0 };
    for (let round = 0; round < ROUNDS; round++) {
      const ana = anas[round]!;
      const bruno = brunos[round]!;
      // nas rodadas pares Bruno leva a venda inteira; nas ímpares, 6 das 10
      const wanted = round % 2 === 0 ? 10 : 6;
      const sale = accepted(await service.place(o.sellLimit(ana, "FLA3", 10, PRICE)));

      // quem sai da barreira 3 ms depois, alternando a cada duas rodadas: as duas ordens de chegada aparecem, e a
      // segunda espera a primeira na trava do clube
      const late = (round >> 1) % 2 === 0 ? "cancel" : "order";
      const together = barrier(2);
      const meet = (side: "order" | "cancel") => async () => {
        await together();
        if (side === late) await sleep(3);
      };
      const [placed, cancelled] = (await Promise.all([
        // a ordem também já está numa transação quando as duas saem da barreira: a corrida é pela trava do clube
        withTransaction(
          db,
          async (tx) => {
            await tx.db.execute(sql`select 1`);
            await meet("order")();
            return service.placeOrder(tx, o.buyLimit(bruno, "FLA3", wanted, PRICE));
          },
          transaction,
        ),
        cancels.cancelOrder({ walletId: ana, orderId: sale.order.id, now: NOW }, { beforeClubLock: meet("cancel"), transaction }),
      ])) as [PlaceOrderResult, CancelOrderResult];

      const purchase = accepted(placed);
      const saleNow = await orderRow(db, sale.order.id);
      const sold = (await db.select().from(trades).where(eq(trades.sellOrderId, sale.order.id))).reduce((n, x) => n + x.quantity, 0);
      expect(saleNow.filled).toBe(sold);
      expect(purchase.order.filled).toBe(sold);

      if (sold > 0) {
        // o negócio veio antes: Bruno levou o que queria, e o cancelamento só pegou a sobra (ou nada)
        outcomes.tradeFirst++;
        expect(sold).toBe(wanted);
        if (wanted === 10) {
          expect(cancelled).toEqual({ ok: false, code: "order_not_open" });
          expect(saleNow.status).toBe("filled");
        } else {
          expect(cancelled.ok).toBe(true);
          expect(saleNow).toMatchObject({ status: "cancelled", cancelReason: "player", filled: 6 });
        }
      } else {
        // o cancelamento veio antes: nenhum negócio, e a compra de Bruno ficou no livro com a reserva inteira
        outcomes.cancelFirst++;
        expect(cancelled.ok).toBe(true);
        expect(saleNow).toMatchObject({ status: "cancelled", filled: 0 });
        expect(purchase.order).toMatchObject({ status: "open", reservedCash: wanted * PRICE });
      }
      // nunca ações presas na venda cancelada nem a mais com Ana
      expect(await positionOf(db, ana, fla3)).toEqual({ shares: 10 - sold, reservedShares: 0, free: 10 - sold });
      expect(await walletOf(db, ana)).toMatchObject({ openOrders: 0, reservedCash: 0, cash: RICH + sold * PRICE });
      expect(await walletOf(db, bruno)).toMatchObject({ reservedCash: (wanted - sold) * PRICE, cash: RICH - sold * PRICE });

      // a sobra de Bruno sai do livro, para a venda da rodada seguinte não casar com ela
      if (purchase.order.status === "open") {
        expect((await cancels.cancelOrder({ walletId: bruno, orderId: purchase.order.id, now: NOW })).ok).toBe(true);
      }
    }
    await assertMarketInvariants(db, seasonId, cashBefore);
    expect(retries).toBe(0);
    // as duas ordens de chegada aconteceram
    expect(outcomes.tradeFirst).toBeGreaterThan(0);
    expect(outcomes.cancelFirst).toBeGreaterThan(0);
    expect(outcomes.tradeFirst + outcomes.cancelFirst).toBe(ROUNDS);
  }, 120_000);
});
