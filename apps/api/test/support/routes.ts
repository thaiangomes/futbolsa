import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Database } from "../../src/infra/db/index.js";
import type { FixedClock } from "../../src/infra/clock/index.js";
import { createAccount } from "./accounts.js";
import { createTestApp, type TestAppOptions } from "./app.js";
import { bearer, withTestAuth } from "./auth.js";

/**
 * Rotas que respondem sem login. Toda rota nova sem `@Public()` precisa de login; uma rota
 * pública nova entra nesta lista no mesmo commit, para a decisão ficar à vista na revisão.
 */
export const PUBLIC_ROUTES: readonly string[] = ["GET /health", "GET /players/:nickname", "GET /season", "GET /clubs", "GET /clubs/:ticker/book"];

export interface RouteScan {
  routes: string[];
  /** Rota sem login que não está em `PUBLIC_ROUTES`, ou que está e pede login. */
  publicViolations: string[];
  /** Rota de `/admin` que não recusa um jogador comum com 403 (ou responde sem login). */
  adminViolations: string[];
}

/** Troca os parâmetros do caminho (`:id`) por um valor qualquer. */
const concrete = (url: string) => url.replace(/:[^/]+/g, "x").replace(/\*/g, "x");

/**
 * Sobe a aplicação inteira, percorre todas as rotas registradas e confere: sem token, só as
 * rotas da lista pública respondem diferente de 401; em `/admin`, um jogador comum recebe 403.
 */
export async function scanRoutes(
  db: Database,
  clock: FixedClock,
  options: Pick<TestAppOptions, "controllers" | "imports"> = {},
  publicRoutes: readonly string[] = PUBLIC_ROUTES,
): Promise<RouteScan> {
  const found: Array<[string, string]> = [];
  const app: NestFastifyApplication = await createTestApp({
    db,
    clock,
    ...options,
    override: withTestAuth(clock),
    onRoute: (method, url) => {
      if (method !== "HEAD" && method !== "OPTIONS") found.push([method, url]);
    },
  });
  try {
    const player = await createAccount(db);
    const scan: RouteScan = { routes: [], publicViolations: [], adminViolations: [] };
    for (const [method, url] of found) {
      const key = `${method} ${url}`;
      scan.routes.push(key);
      const anonymous = await app.inject({ method: method as "GET", url: concrete(url) });
      const isPublic = publicRoutes.includes(key);
      if (!isPublic && anonymous.statusCode !== 401) scan.publicViolations.push(`${key} respondeu ${anonymous.statusCode} sem login`);
      if (isPublic && anonymous.statusCode === 401) scan.publicViolations.push(`${key} está na lista pública mas pede login`);
      if (url === "/admin" || url.startsWith("/admin/")) {
        const asPlayer = await app.inject({ method: method as "GET", url: concrete(url), headers: bearer(player.token) });
        if (asPlayer.statusCode !== 403) scan.adminViolations.push(`${key} respondeu ${asPlayer.statusCode} a um jogador comum`);
      }
    }
    return scan;
  } finally {
    await app.close();
  }
}
