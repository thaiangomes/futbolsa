import "reflect-metadata";
import { Controller, Get, Post } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { AdminOnly, Public } from "../../src/infra/auth-adapter/index.js";
import { FixedClock } from "../../src/infra/clock/index.js";
import { TOKEN_T0 } from "../support/auth.js";
import { useTestDatabase } from "../support/db.js";
import { PUBLIC_ROUTES, scanRoutes } from "../support/routes.js";

const clock = new FixedClock(new Date(TOKEN_T0.getTime() + 60_000));

describe("varredura de todas as rotas", () => {
  const database = useTestDatabase(5);

  it("toda rota sem @Public() responde 401 sem token, e toda rota de /admin dá 403 a jogador comum", async () => {
    const scan = await scanRoutes(database.db, clock);
    expect(scan.routes).toEqual(expect.arrayContaining([...PUBLIC_ROUTES]));
    expect(scan.publicViolations).toEqual([]);
    expect(scan.adminViolations).toEqual([]);
  });

  it("a varredura pega rota pública fora da lista e rota de admin esquecida sem o guard", async () => {
    @Controller("esquecida")
    class ForgottenPublicController {
      @Public()
      @Get()
      open() {
        return { ok: true };
      }
    }

    @Controller("admin/sem-guard")
    class AdminWithoutGuardController {
      @Get()
      read() {
        return { ok: true };
      }
    }

    @AdminOnly()
    @Controller("admin/com-guard")
    class AdminWithGuardController {
      @Post()
      create() {
        return { ok: true };
      }
    }

    const scan = await scanRoutes(database.db, clock, {
      controllers: [ForgottenPublicController, AdminWithoutGuardController, AdminWithGuardController],
    });
    expect(scan.publicViolations).toEqual(["GET /esquecida respondeu 200 sem login"]);
    expect(scan.adminViolations).toEqual(["GET /admin/sem-guard respondeu 200 a um jogador comum"]);
  });
});
