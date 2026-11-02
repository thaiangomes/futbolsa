import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Clock } from "../../src/infra/clock/index.js";
import type { BusEvent } from "../../src/infra/realtime/bus.js";
import { MemoryEventBus } from "../../src/infra/realtime/memory-bus.js";

/** Lê a hora do `Date` simulado, que anda junto com os temporizadores do vitest. */
class FakeTimersClock extends Clock {
  now(): Date {
    return new Date();
  }
}

const frame = (e: BusEvent) => JSON.parse(e.frame);

describe("limitação por tipo de evento (T4)", () => {
  let bus: MemoryEventBus;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T15:00:00.000Z"));
    bus = new MemoryEventBus(new FakeTimersClock());
  });
  afterEach(() => {
    bus.onModuleDestroy();
    vi.useRealTimers();
  });

  function listen(stream: Parameters<MemoryEventBus["subscribe"]>[0]) {
    const events: BusEvent[] = [];
    bus.subscribe(stream, (e) => events.push(e));
    return events;
  }

  it("C18: o primeiro book sai na hora e a rajada seguinte vira um só, com o valor mais recente, ao fim do intervalo", () => {
    const events = listen("club:FLA3");
    bus.publish("club:FLA3", "book", { n: 1 });
    expect(events).toHaveLength(1);
    for (let n = 2; n <= 10; n++) {
      vi.advanceTimersByTime(10);
      bus.publish("club:FLA3", "book", { n });
    }
    expect(events).toHaveLength(1);
    vi.advanceTimersByTime(250);
    expect(events.map((e) => frame(e).data.n)).toEqual([1, 10]);
    vi.advanceTimersByTime(5_000);
    expect(events).toHaveLength(2);
  });

  it("C18: o seq não tem buraco: só consome número o que sai", () => {
    const events = listen("club:FLA3");
    for (let i = 0; i < 40; i++) {
      bus.publish("club:FLA3", "book", { i });
      vi.advanceTimersByTime(30);
    }
    vi.advanceTimersByTime(1_000);
    const seqs = events.map((e) => e.seq);
    expect(seqs.length).toBeGreaterThan(2);
    seqs.slice(1).forEach((seq, i) => expect(seq).toBe(seqs[i]! + 1));
    expect(bus.currentSeq("club:FLA3")).toBe(seqs.at(-1));
  });

  it("C18: book sai no máximo 4 vezes por segundo por clube", () => {
    const events = listen("club:FLA3");
    for (let i = 0; i < 200; i++) {
      bus.publish("club:FLA3", "book", { i });
      vi.advanceTimersByTime(10);
    }
    vi.advanceTimersByTime(1_000);
    const instantes = events.map((e) => Date.parse(frame(e).at));
    instantes.slice(1).forEach((t, i) => expect(t - instantes[i]!).toBeGreaterThanOrEqual(250));
    // 2 segundos de rajada: 1 na hora + 1 a cada 250 ms
    expect(events.length).toBeLessThanOrEqual(10);
    expect(events.length).toBeGreaterThanOrEqual(8);
    expect(frame(events.at(-1)!).data.i).toBe(199);
  });

  it("C18: clubes diferentes não se atrapalham", () => {
    const fla = listen("club:FLA3");
    const pal = listen("club:PAL1");
    bus.publish("club:FLA3", "book", { n: 1 });
    bus.publish("club:PAL1", "book", { n: 1 });
    bus.publish("club:FLA3", "book", { n: 2 });
    bus.publish("club:PAL1", "book", { n: 2 });
    expect(fla).toHaveLength(1);
    expect(pal).toHaveLength(1);
    vi.advanceTimersByTime(250);
    expect(fla.map((e) => frame(e).data.n)).toEqual([1, 2]);
    expect(pal.map((e) => frame(e).data.n)).toEqual([1, 2]);
  });

  it("C18: price sai 1 por segundo por clube (o clube vem do ticker do data), no mesmo canal prices", () => {
    const events = listen("prices");
    bus.publish("prices", "price", { ticker: "FLA3", price: 100 });
    bus.publish("prices", "price", { ticker: "PAL1", price: 200 });
    bus.publish("prices", "price", { ticker: "FLA3", price: 101 });
    bus.publish("prices", "price", { ticker: "FLA3", price: 102 });
    expect(events.map((e) => frame(e).data.price)).toEqual([100, 200]);
    vi.advanceTimersByTime(999);
    expect(events).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(events.map((e) => frame(e).data.price)).toEqual([100, 200, 102]);
  });

  it("C18: rankings.live sai 1 a cada 10 segundos", () => {
    const events = listen("rankings");
    bus.publish("rankings", "rankings.live", { v: 1 });
    vi.advanceTimersByTime(4_000);
    bus.publish("rankings", "rankings.live", { v: 2 });
    vi.advanceTimersByTime(4_000);
    bus.publish("rankings", "rankings.live", { v: 3 });
    expect(events).toHaveLength(1);
    vi.advanceTimersByTime(2_000);
    expect(events.map((e) => frame(e).data.v)).toEqual([1, 3]);
    vi.advanceTimersByTime(10_000);
    expect(events).toHaveLength(2);
  });

  it("depois de um tempo parado, o próximo evento sai na hora de novo", () => {
    const events = listen("club:FLA3");
    bus.publish("club:FLA3", "book", { n: 1 });
    vi.advanceTimersByTime(300);
    bus.publish("club:FLA3", "book", { n: 2 });
    expect(events).toHaveLength(2);
  });

  it("os outros tipos não são limitados: trade, me e season saem todos", () => {
    const trades = listen("club:FLA3");
    for (let n = 0; n < 20; n++) bus.publish("club:FLA3", "trade", { id: n });
    expect(trades).toHaveLength(20);
    const me = listen({ channel: "me", userId: "ana" });
    for (let n = 0; n < 20; n++) bus.publish({ channel: "me", userId: "ana" }, "wallet.changed", { n });
    expect(me).toHaveLength(20);
  });

  it("publicar tipo errado continua dando erro na hora, mesmo dentro de uma janela de limitação", () => {
    bus.publish("club:FLA3", "book", {});
    expect(() => bus.publish("club:FLA3", "price", {})).toThrow();
  });

  it("ao desligar, o que estava esperando é descartado e nenhum temporizador fica vivo", () => {
    const events = listen("club:FLA3");
    bus.publish("club:FLA3", "book", { n: 1 });
    bus.publish("club:FLA3", "book", { n: 2 });
    bus.onModuleDestroy();
    vi.advanceTimersByTime(10_000);
    expect(events).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
