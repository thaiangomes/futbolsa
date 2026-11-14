import "reflect-metadata";
import { beforeAll, describe, expect, it } from "vitest";
import { lockClubs, withTransaction } from "../../src/infra/db/index.js";
import type { PlaceOrderInput } from "../../src/modules/market/index.js";
import { marketSeason } from "../market/helpers.js";
import { giveCash, giveShares, openPlayer, openTreasury, orderInputs, orderService, syncTotalShares } from "../market/order-helpers.js";
import { countingDatabase, type CountingDatabase } from "../support/counting-db.js";
import { useTestDatabase } from "../support/db.js";

/**
 * T18: quantos comandos SQL uma ordem manda com a trava do clube tomada. A trava do clube é o gargalo por clube (a fila dela é a
 * fila de ordens do clube), e o tempo dentro dela é, em boa parte, ida e volta ao banco: cada comando custa uma viagem. O teste
 * guarda um **orçamento** (um teto folgado) para cada caso, para uma mudança futura que ponha dezenas de consultas dentro da trava
 * aparecer aqui, e imprime os números medidos (usados na tabela "Escala" da arquitetura).
 */
const NOW = new Date("2027-04-06T13:05:00Z");

describe("T18: comandos SQL por ordem, dentro da trava do clube", () => {
  const t = useTestDatabase(5);
  let counting: CountingDatabase;
  let seasonId: number;
  let treasury: number;
  let players: number[];
  let o: ReturnType<typeof orderInputs>;
  let service: ReturnType<typeof orderService>["service"];

  beforeAll(async () => {
    const world = await marketSeason(t.db, { tickers: ["FLA3"] });
    seasonId = world.seasonId;
    const clubId = world.clubIds.get("FLA3")!;
    treasury = await openTreasury(t.db, seasonId, 1_000_000_000);
    await giveShares(t.db, treasury, clubId, 5000);
    players = [await openPlayer(t.db, seasonId, 50_000_000), await openPlayer(t.db, seasonId, 50_000_000), await openPlayer(t.db, seasonId, 50_000_000)];
    for (const p of players) await giveShares(t.db, p, clubId, 500);
    await syncTotalShares(t.db, seasonId);
    counting = countingDatabase(t.conn.pool);
    ({ service } = orderService(counting.db));
    o = orderInputs({ seasonId, now: NOW });
  });

  /** Os comandos de uma ordem inteira (19, 31 e 26 em 2026-11-14) (a transação que o `PlayerOrdersService` abre): a trava do clube e a ordem. */
  async function comandos(input: PlaceOrderInput): Promise<{ total: number; escritas: number; negocios: number }> {
    const marca = counting.mark();
    const resultado = await withTransaction(counting.db, async (tx) => {
      await lockClubs(tx, seasonId, [input.ticker]);
      return service.placeOrder(tx, input);
    });
    const lista = counting.since(marca);
    const negocios = resultado.ok ? resultado.trades.length : 0;
    return { total: lista.length, escritas: lista.filter((s) => /^\s*(insert|update|delete)\b/i.test(s)).length, negocios };
  }

  it("ordem limitada que fica no livro, sem negócio", async () => {
    const r = await comandos(o.buyLimit(players[0]!, "FLA3", 5, 3500));
    console.log(`comandos: limitada parada no livro = ${r.total} (${r.escritas} escritas)`);
    expect(r.negocios).toBe(0);
    expect(r.total).toBeLessThanOrEqual(25);
  });

  it("ordem que casa com um jogador: um negócio", async () => {
    await comandos(o.sellLimit(players[1]!, "FLA3", 5, 4200));
    const r = await comandos(o.buyLimit(players[2]!, "FLA3", 5, 4200));
    console.log(`comandos: um negócio entre jogadores = ${r.total} (${r.escritas} escritas)`);
    expect(r.negocios).toBe(1);
    expect(r.total).toBeLessThanOrEqual(40);
  });

  it("ordem a mercado que casa com a casa: um negócio com a tesouraria", async () => {
    await giveCash(t.db, treasury, 0);
    await comandos(o.sellLimit(treasury, "FLA3", 20, 4150, { actor: "house" }));
    const r = await comandos(o.buyMarket(players[0]!, "FLA3", 5));
    console.log(`comandos: um negócio com a casa (tesouraria) = ${r.total} (${r.escritas} escritas)`);
    expect(r.negocios).toBe(1);
    expect(r.total).toBeLessThanOrEqual(40);
  });
});
