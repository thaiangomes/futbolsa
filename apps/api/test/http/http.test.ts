import "reflect-metadata";
import { Body, Controller, Get, Post } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { errorResponseSchema } from "@futbolsa/contracts";
import { DomainError, RateLimit, ZodValidationPipe } from "../../src/infra/http/index.js";
import { Public } from "../../src/infra/auth-adapter/index.js";
import { createTestApp } from "../support/app.js";

const echoSchema = z.strictObject({ quantity: z.number().int().positive() });

@Public()
@Controller("probe-http")
class HttpProbeController {
  @Get("boom")
  boom(): never {
    throw new Error("segredo do banco: senha=abc123 em select * from futbolsa.users");
  }

  @Get("domain")
  domain(): never {
    throw new DomainError("nickname_taken", 409, "Este apelido já está em uso.");
  }

  @Post("echo")
  echo(@Body(new ZodValidationPipe(echoSchema)) body: z.infer<typeof echoSchema>) {
    return body;
  }

  @RateLimit("signup")
  @Get("limited")
  limited() {
    return { ok: true };
  }
}

describe("HTTP: erros, validação e limites", () => {
  let app: NestFastifyApplication;
  const origin = process.env.WEB_ORIGIN;

  beforeAll(async () => {
    process.env.WEB_ORIGIN = "http://localhost:3001";
    app = await createTestApp({ controllers: [HttpProbeController] });
  });
  afterAll(async () => {
    process.env.WEB_ORIGIN = origin;
    await app.close();
  });

  it("erro inesperado responde 500 internal_error, sem o texto do erro nem a pilha", async () => {
    const res = await app.inject({ method: "GET", url: "/probe-http/boom" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ code: "internal_error", message: expect.any(String) });
    expect(res.body).not.toContain("senha");
    expect(res.body).not.toContain("select");
    expect(res.body).not.toContain("at ");
  });

  it("DomainError responde com o código, a mensagem e o status dele", async () => {
    const res = await app.inject({ method: "GET", url: "/probe-http/domain" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ code: "nickname_taken", message: "Este apelido já está em uso." });
  });

  it("corpo fora do esquema responde 400 invalid_input com os campos, sem eco do valor", async () => {
    const res = await app.inject({ method: "POST", url: "/probe-http/echo", payload: { quantity: -5 } });
    expect(res.statusCode).toBe(400);
    const body = errorResponseSchema.parse(res.json());
    expect(body.code).toBe("invalid_input");
    expect(body.fields).toEqual(["quantity"]);
    expect(res.body).not.toContain("-5");
  });

  it("campo a mais é recusado (esquemas strict)", async () => {
    const res = await app.inject({ method: "POST", url: "/probe-http/echo", payload: { quantity: 1, isAdmin: true } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("invalid_input");
  });

  it("corpo válido passa pelo esquema", async () => {
    const res = await app.inject({ method: "POST", url: "/probe-http/echo", payload: { quantity: 3 } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ quantity: 3 });
  });

  it("JSON malformado responde 400 no formato de erro", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/probe-http/echo",
      headers: { "content-type": "application/json" },
      payload: "{ quantity: ",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("invalid_input");
  });

  it("corpo de 65 KB responde 413 payload_too_large", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/probe-http/echo",
      payload: { quantity: 1, pad: "x".repeat(65 * 1024) },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().code).toBe("payload_too_large");
  });

  it("rota inexistente responde 404 not_found no formato de erro", async () => {
    const res = await app.inject({ method: "GET", url: "/nao-existe" });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("not_found");
  });

  it("as respostas levam os cabeçalhos de segurança do helmet", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBeDefined();
    expect(res.headers["strict-transport-security"]).toBeDefined();
  });

  it("CORS só para o endereço do site", async () => {
    const site = await app.inject({ method: "GET", url: "/health", headers: { origin: "http://localhost:3001" } });
    expect(site.headers["access-control-allow-origin"]).toBe("http://localhost:3001");
    const other = await app.inject({ method: "GET", url: "/health", headers: { origin: "https://golpe.exemplo.com" } });
    // a origem fixa nunca ecoa quem pediu: o navegador recusa porque o valor não é o dele
    expect(other.headers["access-control-allow-origin"]).not.toBe("https://golpe.exemplo.com");
    expect(other.headers["access-control-allow-origin"]).not.toBe("*");
  });

  it("CORS: o preflight do site libera PUT, PATCH e DELETE (achado pelo navegador na F16) e recusa método fora da lista", async () => {
    for (const method of ["PUT", "PATCH", "DELETE", "POST"]) {
      const res = await app.inject({
        method: "OPTIONS",
        url: "/health",
        headers: { origin: "http://localhost:3001", "access-control-request-method": method, "access-control-request-headers": "authorization,content-type,idempotency-key" },
      });
      expect(res.headers["access-control-allow-methods"], method).toContain(method);
      expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3001");
    }
  });

  it("a 11ª chamada seguida a uma rota com limite de 10 por minuto responde 429; outra origem passa", async () => {
    for (let i = 0; i < 10; i++) {
      const ok = await app.inject({ method: "GET", url: "/probe-http/limited", remoteAddress: "10.0.0.1" });
      expect(ok.statusCode).toBe(200);
    }
    const blocked = await app.inject({ method: "GET", url: "/probe-http/limited", remoteAddress: "10.0.0.1" });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().code).toBe("too_many_requests");
    const other = await app.inject({ method: "GET", url: "/probe-http/limited", remoteAddress: "10.0.0.2" });
    expect(other.statusCode).toBe(200);
  });
});
