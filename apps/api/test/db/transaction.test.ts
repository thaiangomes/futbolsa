import { eq, inArray, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { clubs } from "../../src/infra/db/schema/index.js";
import { MAX_RETRIES, withTransaction } from "../../src/infra/db/transaction.js";
import { LedgerError } from "../../src/modules/portfolio/ledger/index.js";
import { useTestDatabase } from "../support/db.js";
import { deferred, seedSeason } from "../support/fixtures.js";

const retryable = (code: string) => Object.assign(new Error(`falha ${code}`), { code });

describe("T5: withTransaction", () => {
  const t = useTestDatabase();
  let fla: number;
  let pal: number;

  beforeAll(async () => {
    const { clubIds } = await seedSeason(t.db);
    fla = clubIds.get("FLA3")!;
    pal = clubIds.get("PAL3")!;
  });

  const nameOf = async (id: number) => (await t.db.select().from(clubs).where(eq(clubs.id, id)))[0]!.name;

  it("um erro no meio desfaz tudo o que a função gravou", async () => {
    await expect(
      withTransaction(t.db, async (tx) => {
        await tx.db.update(clubs).set({ name: "mudou" }).where(eq(clubs.id, fla));
        throw new Error("falhou no meio");
      }),
    ).rejects.toThrow("falhou no meio");
    expect(await nameOf(fla)).toBe("Flamengo");
  });

  it("deadlock de verdade: o Postgres aborta uma transação, ela é repetida e as duas terminam gravadas", async () => {
    const firstLocked = deferred();
    const secondLocked = deferred();
    const retries: string[] = [];
    let crossed = false;
    // trava as duas linhas em ordem trocada, de propósito, sem as travas da T6
    const run = (mine: number, other: number, label: string, signal: () => void, wait: Promise<void>) =>
      withTransaction(
        t.db,
        async (tx) => {
          await tx.db.update(clubs).set({ name: sql`${clubs.name} || ${`+${label}`}` }).where(eq(clubs.id, mine));
          if (!crossed) {
            signal();
            await wait;
          }
          await tx.db.update(clubs).set({ name: sql`${clubs.name} || ${`+${label}`}` }).where(eq(clubs.id, other));
        },
        {
          onRetry: (_attempt, code) => {
            crossed = true;
            retries.push(code);
          },
        },
      );
    await Promise.all([
      run(fla, pal, "a", firstLocked.resolve, secondLocked.promise),
      run(pal, fla, "b", secondLocked.resolve, firstLocked.promise),
    ]);
    expect(retries).toEqual(["40P01"]);
    const names = (await t.db.select().from(clubs).where(inArray(clubs.id, [fla, pal]))).map((c) => c.name);
    for (const name of names) {
      expect(name).toContain("+a");
      expect(name).toContain("+b");
    }
    await t.db.update(clubs).set({ name: "Flamengo" }).where(eq(clubs.id, fla));
    await t.db.update(clubs).set({ name: "Palmeiras" }).where(eq(clubs.id, pal));
  });

  it("conflito de serialização na primeira tentativa é repetido", async () => {
    let attempts = 0;
    const result = await withTransaction(t.db, async () => {
      attempts++;
      if (attempts === 1) throw retryable("40001");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });

  it(`falhar ${MAX_RETRIES + 1} vezes seguidas sobe o erro e nada fica gravado`, async () => {
    let attempts = 0;
    await expect(
      withTransaction(t.db, async (tx) => {
        attempts++;
        await tx.db.update(clubs).set({ name: `tentativa ${attempts}` }).where(eq(clubs.id, fla));
        throw retryable("40P01");
      }),
    ).rejects.toThrow("falha 40P01");
    expect(attempts).toBe(MAX_RETRIES + 1);
    expect(await nameOf(fla)).toBe("Flamengo");
  });

  it("um erro de regra não é repetido", async () => {
    let attempts = 0;
    await expect(
      withTransaction(t.db, async () => {
        attempts++;
        throw new LedgerError("negative_cash", "saldo insuficiente");
      }),
    ).rejects.toThrow("saldo insuficiente");
    expect(attempts).toBe(1);
  });

  it("afterCommit não roda quando a transação desfaz", async () => {
    let ran = 0;
    await expect(
      withTransaction(t.db, async (tx) => {
        tx.afterCommit(() => {
          ran++;
        });
        throw new Error("desfaz");
      }),
    ).rejects.toThrow();
    expect(ran).toBe(0);
  });

  it("afterCommit roda uma vez depois de uma repetição, com o COMMIT já visível por outra conexão", async () => {
    let attempts = 0;
    const seen: string[] = [];
    await withTransaction(t.db, async (tx) => {
      attempts++;
      await tx.db.update(clubs).set({ name: "Flamengo depois" }).where(eq(clubs.id, fla));
      tx.afterCommit(async () => {
        // o pool usa outra conexão: só vê o nome novo se o COMMIT já aconteceu
        seen.push(await nameOf(fla));
      });
      if (attempts === 1) throw retryable("40001");
    });
    expect(attempts).toBe(2);
    expect(seen).toEqual(["Flamengo depois"]);
    await t.db.update(clubs).set({ name: "Flamengo" }).where(eq(clubs.id, fla));
  });

  it("um erro no afterCommit não desfaz nem falha a operação já gravada", async () => {
    const errors: unknown[] = [];
    await withTransaction(
      t.db,
      async (tx) => {
        await tx.db.update(clubs).set({ name: "gravado" }).where(eq(clubs.id, pal));
        tx.afterCommit(() => {
          throw new Error("evento falhou");
        });
      },
      { onAfterCommitError: (e) => errors.push(e) },
    );
    expect(errors).toHaveLength(1);
    expect(await nameOf(pal)).toBe("gravado");
    await t.db.update(clubs).set({ name: "Palmeiras" }).where(eq(clubs.id, pal));
  });
});
