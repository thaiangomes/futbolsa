import { describe, expect, it } from "vitest";
import { deferred } from "../support/fixtures.js";
import { ENTRY_QUEUE_LIMIT, EntryGate } from "../../src/modules/entry/entry-gate.js";

describe("EntryGate (P2)", () => {
  it("roda uma por vez, na ordem de chegada", async () => {
    const gate = new EntryGate();
    const order: string[] = [];
    const first = deferred();
    const a = gate.run(async () => {
      order.push("a1");
      await first.promise;
      order.push("a2");
    });
    const b = gate.run(async () => void order.push("b"));
    await Promise.resolve();
    expect(order).toEqual(["a1"]);
    first.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(["a1", "a2", "b"]);
    expect(gate.queued).toBe(0);
  });

  it("a fila cheia recebe entry_busy (503)", async () => {
    const gate = new EntryGate();
    const hold = deferred();
    const running = gate.run(() => hold.promise);
    const waiting = Array.from({ length: ENTRY_QUEUE_LIMIT }, () => gate.run(async () => undefined));
    await expect(gate.run(async () => undefined)).rejects.toMatchObject({ code: "entry_busy", status: 503 });
    hold.resolve();
    await Promise.all([running, ...waiting]);
  });

  it("quem espera demais na fila desiste com entry_busy e a fila segue", async () => {
    const gate = new EntryGate();
    gate.waitMs = 50;
    const hold = deferred();
    const running = gate.run(() => hold.promise);
    const impatient = gate.run(async () => "nunca");
    await expect(impatient).rejects.toMatchObject({ code: "entry_busy" });
    expect(gate.queued).toBe(0);
    hold.resolve();
    await running;
    expect(await gate.run(async () => "livre")).toBe("livre");
  });
});
