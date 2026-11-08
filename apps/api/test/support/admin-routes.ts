import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { eq } from "drizzle-orm";
import { expect } from "vitest";
import type { Database } from "../../src/infra/db/index.js";
import { users } from "../../src/infra/db/schema/index.js";
import { createAccount } from "./accounts.js";
import { bearer } from "./auth.js";

export interface AdminRoute {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** O caminho já com os parâmetros trocados por valores. */
  url: string;
  payload?: unknown;
}

/**
 * Confere, para uma rota de `/admin`, o acesso da Admin, critério 31: sem login 401
 * `invalid_token`; jogador comum e admin bloqueado 403 `admin_required`; admin ativo passa
 * (qualquer resposta que não seja 401 nem 403, ou o `okStatus` dado); e quem perde o papel perde o
 * acesso na chamada seguinte, com o mesmo token. Cada tarefa de rota da F7 chama isto para
 * todas as rotas dela.
 */
export async function expectAdminOnly(
  app: NestFastifyApplication,
  db: Database,
  route: AdminRoute,
  options: { okStatus?: number } = {},
): Promise<void> {
  const call = (token?: string) =>
    app.inject({
      method: route.method,
      url: route.url,
      ...(route.payload === undefined ? {} : { payload: route.payload as object }),
      ...(token ? { headers: bearer(token) } : {}),
    });
  const label = `${route.method} ${route.url}`;

  const anonymous = await call();
  expect(anonymous.statusCode, `${label} sem login`).toBe(401);
  expect(anonymous.json().code, `${label} sem login`).toBe("invalid_token");

  const player = await createAccount(db);
  const asPlayer = await call(player.token);
  expect(asPlayer.statusCode, `${label} para jogador comum`).toBe(403);
  expect(asPlayer.json().code, `${label} para jogador comum`).toBe("admin_required");

  const blocked = await createAccount(db, { role: "admin", status: "blocked" });
  const asBlocked = await call(blocked.token);
  expect(asBlocked.statusCode, `${label} para admin bloqueado`).toBe(403);
  expect(asBlocked.json().code, `${label} para admin bloqueado`).toBe("admin_required");

  const admin = await createAccount(db, { role: "admin" });
  const asAdmin = await call(admin.token);
  if (options.okStatus === undefined) {
    expect([401, 403], `${label} para admin`).not.toContain(asAdmin.statusCode);
  } else {
    expect(asAdmin.statusCode, `${label} para admin`).toBe(options.okStatus);
  }

  // O papel é lido do banco a cada chamada, nunca do token: sem o papel, o mesmo token já não passa.
  await db.update(users).set({ role: "player" }).where(eq(users.id, admin.id));
  const afterLoss = await call(admin.token);
  expect(afterLoss.statusCode, `${label} depois de perder o papel`).toBe(403);
  expect(afterLoss.json().code, `${label} depois de perder o papel`).toBe("admin_required");
}
