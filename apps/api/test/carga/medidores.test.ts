import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Histograma, MedidoresHistograma } from "../../carga/medidores.js";
import { lockClubs, lockSeason, lockWallets } from "../../src/infra/db/locks.js";
import { metrics, NoopMetrics, setMetrics } from "../../src/infra/db/metrics.js";
import { LockOrderError, withTransaction } from "../../src/infra/db/transaction.js";
import { marketSeason } from "../market/helpers.js";
import { useTestDatabase } from "../support/db.js";
import { createUser, openWallets } from "../support/fixtures.js";

afterEach(() => setMetrics(undefined));

describe("T15: histograma", () => {
  it("p50, p95 e p99 de 1 a 1000 ms ficam dentro de 2% do valor exato", () => {
    const h = new Histograma();
    for (let i = 1; i <= 1000; i++) h.registrar(i);
    const r = h.resumo();
    expect(r.n).toBe(1000);
    for (const [obtido, exato] of [[r.p50, 500], [r.p95, 950], [r.p99, 990]] as const) {
      expect(obtido).toBeGreaterThan(exato * 0.98);
      expect(obtido).toBeLessThan(exato * 1.02);
    }
    expect(r.max).toBe(1000);
  });

  it("sem amostras devolve zeros", () => {
    expect(new Histograma().resumo()).toEqual({ n: 0, media: 0, p50: 0, p95: 0, p99: 0, max: 0 });
  });
});

describe("T15: medidores nas travas", () => {
  const t = useTestDatabase();
  let seasonId: number;
  let jogador: number;
  let tesouraria: number;

  beforeAll(async () => {
    ({ seasonId } = await marketSeason(t.db));
    [jogador, tesouraria] = (await openWallets(t.db, seasonId, [{ type: "user", userId: await createUser(t.db) }, { type: "treasury" }])) as [number, number];
  });

  it("por padrão os medidores não fazem nada e as travas funcionam como antes", async () => {
    expect(metrics()).toBeInstanceOf(NoopMetrics);
    expect(metrics().enabled).toBe(false);
    await withTransaction(t.db, async (tx) => {
      await lockSeason(tx, seasonId, "share");
      await lockClubs(tx, seasonId, ["FLA3"]);
    });
  });

  it("com medidores ligados, registra espera e retenção de cada trava, com a tesouraria à parte", async () => {
    const medidores = new MedidoresHistograma();
    setMetrics(medidores);
    await withTransaction(t.db, async (tx) => {
      await lockSeason(tx, seasonId, "share");
      await lockClubs(tx, seasonId, ["FLA3"]);
      await lockWallets(tx, [jogador]);
    });
    await withTransaction(t.db, async (tx) => {
      await lockClubs(tx, seasonId, ["PAL3"]);
      await lockWallets(tx, [jogador, tesouraria]);
      await new Promise((r) => setTimeout(r, 30));
    });
    const r = medidores.relatorio();
    expect(r.travas.season!.espera.n).toBe(1);
    expect(r.travas.club!.espera.n).toBe(2);
    expect(r.travas.wallet!.espera.n).toBe(1);
    expect(r.travas.wallet_treasury!.espera.n).toBe(1);
    expect(r.clubes.FLA3!.retencao.n).toBe(1);
    // a trava do PAL3 ficou segura durante a pausa de 30 ms
    expect(r.clubes.PAL3!.retencao.p50).toBeGreaterThanOrEqual(29);
  });

  it("conta a repetição por deadlock e a que esgota as tentativas", async () => {
    const medidores = new MedidoresHistograma();
    setMetrics(medidores);
    let tentativas = 0;
    await withTransaction(t.db, async () => {
      tentativas++;
      if (tentativas < 3) throw Object.assign(new Error("deadlock"), { code: "40P01" });
    });
    expect(medidores.relatorio().repeticoes).toEqual({ total: 2, porCodigo: { "40P01": 2 }, esgotadas: 0 });
    await expect(
      withTransaction(t.db, async () => {
        throw Object.assign(new Error("deadlock"), { code: "40P01" });
      }),
    ).rejects.toThrow("deadlock");
    expect(medidores.relatorio().repeticoes.esgotadas).toBe(1);
  });

  it("a ordem das travas continua recusada com os medidores ligados", async () => {
    setMetrics(new MedidoresHistograma());
    await expect(
      withTransaction(t.db, async (tx) => {
        await lockWallets(tx, [jogador]);
        await lockClubs(tx, seasonId, ["FLA3"]);
      }),
    ).rejects.toBeInstanceOf(LockOrderError);
  });
});
