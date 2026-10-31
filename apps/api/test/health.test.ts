import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { healthResponseSchema } from "@futbolsa/contracts";
import { createApp } from "../src/app.js";

describe("GET /health", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(() => app.close());

  it("C4: responde 200 com status ok e o preço mínimo vindo do motor", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", minPrice: 50 });
    expect(healthResponseSchema.safeParse(res.json()).success).toBe(true);
  });
});
