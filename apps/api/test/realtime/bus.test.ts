import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FixedClock } from "../../src/infra/clock/index.js";
import { meChannel, type BusEvent } from "../../src/infra/realtime/bus.js";
import { MemoryEventBus } from "../../src/infra/realtime/memory-bus.js";

const START = new Date("2026-11-02T15:00:00.000Z");

function setup(options?: ConstructorParameters<typeof MemoryEventBus>[1]) {
  const clock = new FixedClock(START);
  // a limitação por tipo tem teste próprio (throttle.test.ts); aqui cada publicação sai
  const bus = new MemoryEventBus(clock, { throttle: {}, ...options });
  return { clock, bus };
}

/** Assina e junta tudo o que chega (reenvio e ao vivo) na ordem em que o gateway enviaria. */
function listen(bus: MemoryEventBus, stream: Parameters<MemoryEventBus["subscribe"]>[0], since?: number) {
  const live: BusEvent[] = [];
  const sub = bus.subscribe(stream, (event) => live.push(event), since);
  return { sub, live, all: () => [...sub.replay, ...live].map((e) => e.seq) };
}

const frameOf = (event: BusEvent) => JSON.parse(event.frame);

describe("barramento em memória (T3)", () => {
  describe("seq", () => {
    it("C13: o seq de um canal cresce de 1 em 1, a partir do horário", () => {
      const { bus } = setup();
      const base = START.getTime();
      expect(bus.currentSeq("prices")).toBe(base);
      bus.publish("prices", "price", { ticker: "FLA3" });
      bus.publish("prices", "price", { ticker: "FLA3" });
      bus.publish("prices", "price", { ticker: "FLA3" });
      expect(bus.currentSeq("prices")).toBe(base + 3);
    });

    it("C13: cada canal tem o seu seq, independente dos outros", () => {
      const { bus, clock } = setup();
      bus.currentSeq("prices");
      clock.advance(5);
      bus.publish("season", "season.status", {});
      bus.publish("season", "season.status", {});
      const a = listen(bus, "prices");
      const b = listen(bus, "club:FLA3");
      bus.publish("prices", "price", {});
      bus.publish("club:FLA3", "trade", {});
      bus.publish("club:FLA3", "trade", {});
      expect(a.live.map((e) => e.seq)).toEqual([START.getTime() + 1]);
      expect(b.live.map((e) => e.seq)).toEqual([START.getTime() + 5 + 1, START.getTime() + 5 + 2]);
    });

    it("C13: um barramento novo (reinício) começa acima de qualquer seq do anterior", () => {
      const antes = setup();
      for (let i = 0; i < 300; i++) antes.bus.publish("club:FLA3", "book", { i });
      const ultimo = antes.bus.currentSeq("club:FLA3");
      // a API reinicia um segundo depois: o relógio andou mais do que os eventos publicados
      const clock = new FixedClock(new Date(START.getTime() + 1000));
      const depois = new MemoryEventBus(clock, { throttle: {} });
      expect(depois.currentSeq("club:FLA3")).toBeGreaterThan(ultimo);
    });
  });

  describe("entrega", () => {
    it("C14: cada assinante recebe os eventos na ordem, uma vez, com o at do relógio", () => {
      const { bus, clock } = setup();
      const a = listen(bus, "club:FLA3");
      const b = listen(bus, "club:FLA3");
      bus.publish("club:FLA3", "trade", { id: "n1" });
      clock.advance(1500);
      bus.publish("club:FLA3", "trade", { id: "n2" });
      for (const { live } of [a, b]) {
        expect(live.map((e) => frameOf(e).data.id)).toEqual(["n1", "n2"]);
        expect(frameOf(live[0]!)).toEqual({
          type: "trade",
          channel: "club:FLA3",
          seq: START.getTime() + 1,
          at: "2026-11-02T15:00:00.000Z",
          data: { id: "n1" },
        });
        expect(frameOf(live[1]!).at).toBe("2026-11-02T15:00:01.500Z");
      }
    });

    it("C14: o quadro JSON é montado uma vez por evento, com 1 ou com 50 assinantes", () => {
      const { bus } = setup();
      const listeners = Array.from({ length: 50 }, () => listen(bus, "prices"));
      let serializacoes = 0;
      bus.publish("prices", "price", {
        toJSON() {
          serializacoes++;
          return { ticker: "FLA3" };
        },
      });
      expect(serializacoes).toBe(1);
      const quadros = new Set(listeners.map((l) => l.live[0]!.frame));
      expect(quadros.size).toBe(1);
    });

    it("C14: quem não assinou o canal não recebe nada, e depois de unsubscribe nada mais chega", () => {
      const { bus } = setup();
      const prices = listen(bus, "prices");
      const season = listen(bus, "season");
      bus.publish("prices", "price", {});
      expect(prices.live).toHaveLength(1);
      expect(season.live).toHaveLength(0);
      prices.sub.unsubscribe();
      bus.publish("prices", "price", {});
      expect(prices.live).toHaveLength(1);
    });

    it("um assinante que lança erro não impede os outros de receber", () => {
      const { bus } = setup();
      bus.subscribe("prices", () => {
        throw new Error("socket quebrado");
      });
      const ok = listen(bus, "prices");
      bus.publish("prices", "price", {});
      expect(ok.live).toHaveLength(1);
    });

    it("C4: publicar um tipo no canal errado é erro, e nada é entregue", () => {
      const { bus } = setup();
      const l = listen(bus, "prices");
      expect(() => bus.publish("prices", "trade", {})).toThrow(/trade/);
      expect(() => bus.publish("club:FLA3", "wallet.changed", {})).toThrow();
      expect(l.live).toHaveLength(0);
      expect(bus.currentSeq("prices")).toBe(START.getTime());
    });

    it("o módulo dono registra o esquema do data e o conteúdo é conferido", () => {
      const { bus } = setup();
      bus.registerSchema("price", z.object({ ticker: z.string(), price: z.number().int() }));
      expect(() => bus.publish("prices", "price", { ticker: "FLA3", price: 1.5 })).toThrow(/price/);
      expect(() => bus.publish("prices", "price", { ticker: "FLA3", price: 150 })).not.toThrow();
    });
  });

  describe("canal me", () => {
    it("C9: o evento do me chega só ao dono, e o seq é por pessoa", () => {
      const { bus } = setup();
      const ana = listen(bus, meChannel("ana"));
      const ana2 = listen(bus, meChannel("ana"));
      const beto = listen(bus, meChannel("beto"));
      const publico = listen(bus, "prices");
      bus.publish(meChannel("ana"), "wallet.changed", { cash: 1 });
      bus.publish(meChannel("ana"), "wallet.changed", { cash: 2 });
      bus.publish(meChannel("beto"), "wallet.changed", { cash: 9 });
      expect(ana.live).toHaveLength(2);
      expect(ana2.live).toHaveLength(2);
      expect(beto.live).toHaveLength(1);
      expect(publico.live).toHaveLength(0);
      expect(ana.live.map((e) => e.seq)).toEqual([START.getTime() + 1, START.getTime() + 2]);
      expect(beto.live.map((e) => e.seq)).toEqual([START.getTime() + 1]);
      expect(frameOf(ana.live[0]!).channel).toBe("me");
      expect(JSON.stringify(frameOf(ana.live[0]!))).not.toContain("ana");
    });

    it("publicar no me sem dizer a quem é erro", () => {
      const { bus } = setup();
      expect(() => bus.publish("me", "wallet.changed", {})).toThrow();
      expect(() => bus.subscribe("me", () => {})).toThrow();
    });
  });

  describe("retomada", () => {
    it("C16: reconexão com since dentro do histórico reenvia só o que faltou, em ordem", () => {
      const { bus } = setup();
      const base = START.getTime();
      for (let i = 1; i <= 5; i++) bus.publish("club:FLA3", "trade", { i });
      const r = listen(bus, "club:FLA3", base + 2);
      expect(r.sub.mode).toBe("resumed");
      expect(r.sub.seq).toBe(base + 5);
      expect(r.sub.replay.map((e) => e.seq)).toEqual([base + 3, base + 4, base + 5]);
      expect(r.live).toEqual([]);
    });

    it("C16: depois do reenvio segue ao vivo sem repetir nem perder, inclusive o que sai logo em seguida", () => {
      const { bus } = setup();
      const base = START.getTime();
      for (let i = 1; i <= 3; i++) bus.publish("club:FLA3", "trade", { i });
      const r = listen(bus, "club:FLA3", base + 1);
      // eventos publicados antes de o gateway terminar de enviar o reenvio
      bus.publish("club:FLA3", "trade", { i: 4 });
      bus.publish("club:FLA3", "trade", { i: 5 });
      expect(r.all()).toEqual([base + 2, base + 3, base + 4, base + 5]);
    });

    it("C16: since igual ao seq atual é retomada sem nada a reenviar", () => {
      const { bus } = setup();
      bus.publish("prices", "price", {});
      const r = listen(bus, "prices", bus.currentSeq("prices"));
      expect(r.sub.mode).toBe("resumed");
      expect(r.sub.replay).toEqual([]);
      bus.publish("prices", "price", {});
      expect(r.live).toHaveLength(1);
    });

    it("sem since, a assinatura é ao vivo e informa o seq atual", () => {
      const { bus } = setup();
      bus.publish("prices", "price", {});
      const r = listen(bus, "prices");
      expect(r.sub.mode).toBe("live");
      expect(r.sub.seq).toBe(START.getTime() + 1);
      expect(r.sub.replay).toEqual([]);
    });

    it("C17: since mais velho que o histórico (200 eventos) dá resync", () => {
      const { bus } = setup();
      const base = START.getTime();
      for (let i = 1; i <= 250; i++) bus.publish("club:FLA3", "book", { i });
      // o histórico guarda do 51 ao 250
      expect(listen(bus, "club:FLA3", base + 49).sub.mode).toBe("resync");
      expect(listen(bus, "club:FLA3", base + 50).sub.mode).toBe("resumed");
      expect(listen(bus, "club:FLA3", base + 50).sub.replay).toHaveLength(200);
    });

    it("C17: since mais velho que 60 segundos dá resync", () => {
      const { bus, clock } = setup();
      const base = START.getTime();
      bus.publish("club:FLA3", "trade", {});
      bus.publish("club:FLA3", "trade", {});
      clock.advance(61_000);
      bus.publish("club:FLA3", "trade", {});
      expect(listen(bus, "club:FLA3", base).sub.mode).toBe("resync");
      expect(listen(bus, "club:FLA3", base + 2).sub.mode).toBe("resumed");
    });

    it("C17: since maior que o seq atual dá resync", () => {
      const { bus } = setup();
      bus.publish("prices", "price", {});
      expect(listen(bus, "prices", START.getTime() + 99).sub.mode).toBe("resync");
    });

    it("C17: since vindo de antes de um reinício dá resync e o seq continua para cima", () => {
      const antes = setup();
      for (let i = 0; i < 10; i++) antes.bus.publish("club:FLA3", "trade", { i });
      const visto = antes.bus.currentSeq("club:FLA3");

      const clock = new FixedClock(new Date(START.getTime() + 30_000));
      const depois = new MemoryEventBus(clock);
      const r = listen(depois, "club:FLA3", visto);
      expect(r.sub.mode).toBe("resync");
      expect(r.sub.seq).toBeGreaterThan(visto);
      depois.publish("club:FLA3", "trade", {});
      expect(r.live[0]!.seq).toBe(r.sub.seq + 1);
    });

    it("C17: o histórico do me guarda 50 eventos", () => {
      const { bus } = setup();
      const base = START.getTime();
      for (let i = 1; i <= 80; i++) bus.publish(meChannel("ana"), "entry.added", { i });
      expect(listen(bus, meChannel("ana"), base + 29).sub.mode).toBe("resync");
      expect(listen(bus, meChannel("ana"), base + 30).sub.replay).toHaveLength(50);
    });

    it("o histórico do me vale 5 minutos, o dos canais públicos 1", () => {
      const { bus, clock } = setup();
      const base = START.getTime();
      bus.publish(meChannel("ana"), "entry.added", {});
      bus.publish("prices", "price", {});
      clock.advance(120_000);
      bus.publish(meChannel("ana"), "entry.added", {});
      bus.publish("prices", "price", {});
      expect(listen(bus, meChannel("ana"), base).sub.mode).toBe("resumed");
      expect(listen(bus, "prices", base).sub.mode).toBe("resync");
    });
  });

  describe("memória", () => {
    it("assinar canais inventados e sair não deixa nada guardado", () => {
      const { bus } = setup();
      const subs = ["club:AAA1", "club:AAA2", "club:AAA3"].map((c) => listen(bus, c as "club:AAA1"));
      expect(bus.trackedStreams()).toBe(3);
      subs.forEach((s) => s.sub.unsubscribe());
      expect(bus.trackedStreams()).toBe(0);
    });

    it("um canal que já teve evento guarda o contador (o seq nunca volta)", () => {
      const { bus } = setup();
      const l = listen(bus, "club:FLA3");
      bus.publish("club:FLA3", "trade", {});
      l.sub.unsubscribe();
      expect(bus.currentSeq("club:FLA3")).toBe(START.getTime() + 1);
    });

    it("unsubscribe duas vezes não quebra", () => {
      const { bus } = setup();
      const l = listen(bus, "prices");
      l.sub.unsubscribe();
      expect(() => l.sub.unsubscribe()).not.toThrow();
    });
  });
});
