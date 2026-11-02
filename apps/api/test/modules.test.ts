import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app.js";
import { Clock, FixedClock } from "../src/infra/clock/index.js";

describe("aplicação com todos os módulos", () => {
  const fixo = new FixedClock(new Date("2026-11-01T15:00:00Z"));
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(Clock)
      .useValue(fixo)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(() => app.close());

  it("C5: sobe com os 8 módulos e a infraestrutura registrados e responde /health", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });

  it("C5: o relógio fixo substitui o real na injeção", () => {
    const clock = app.get(Clock);
    expect(clock).toBe(fixo);
    expect(clock.now().toISOString()).toBe("2026-11-01T15:00:00.000Z");
    fixo.advance(60_000);
    expect(app.get(Clock).now().toISOString()).toBe("2026-11-01T15:01:00.000Z");
  });
});
