// `npm run e2e:supabase -w @futbolsa/web` (T23 do Plano do ensaio, carga e testes no navegador).
//
// SÓ À MÃO, NUNCA NO CI: usa o projeto do Supabase hospedado e a chave de serviço, que o Thaian põe no ambiente na hora
// (nunca em arquivo commitado). Veja `README.md` nesta pasta. O script:
//   1. confere as variáveis e se recusa a rodar sem elas ou contra um banco que não seja local;
//   2. cria o banco local `futbolsa_e2e_supabase` (migrações de verdade) e o apaga no fim;
//   3. constrói o site normal (login do Supabase de verdade, sem o login falso) em `out-supabase/`;
//   4. sobe a API de verdade (build normal) e um servidor estático para o site;
//   5. roda o Playwright com `playwright.supabase.config.ts` e derruba tudo, mesmo se o teste falhar.
import { spawn, spawnSync } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const RAIZ = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const WEB = join(RAIZ, "apps/web");
const API = join(RAIZ, "apps/api");
const PORTA_API = 3200;
const PORTA_SITE = 3201;
const BANCO = "futbolsa_e2e_supabase";

const obrigatorias = ["TEST_DATABASE_URL", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
const faltando = obrigatorias.filter((n) => !process.env[n]);
if (faltando.length) {
  console.error(`Faltam variáveis de ambiente: ${faltando.join(", ")}. Veja apps/web/e2e/supabase/README.md.`);
  process.exit(1);
}
const urlLocal = new URL(process.env.TEST_DATABASE_URL);
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(urlLocal.hostname)) {
  console.error("TEST_DATABASE_URL precisa ser um Postgres local: este roteiro cria e apaga um banco nele.");
  process.exit(1);
}
if (/supabase\.(co|com)$/i.test(urlLocal.hostname)) process.exit(1);

const filhos = [];
let servidorSite;
async function admin(sql) {
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}
const urlDoBanco = (() => {
  const u = new URL(process.env.TEST_DATABASE_URL);
  u.pathname = `/${BANCO}`;
  return u.toString();
})();

async function limpar() {
  for (const f of filhos) f.kill();
  await new Promise((ok) => (servidorSite ? servidorSite.close(() => ok()) : ok()));
  await admin(`drop database if exists "${BANCO}" with (force)`).catch(() => undefined);
}

function rodar(comando, args, opcoes = {}) {
  const r = spawnSync(comando, args, { stdio: "inherit", cwd: RAIZ, shell: process.platform === "win32", ...opcoes });
  if (r.status !== 0) throw new Error(`${comando} ${args.join(" ")} falhou (${r.status})`);
}

const TIPOS = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".json": "application/json", ".txt": "text/plain", ".svg": "image/svg+xml" };
function servir(pasta, porta) {
  const raiz = resolve(pasta);
  const http = createServer((req, res) => {
    const caminho = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const achado = [caminho, `${caminho}.html`, join(caminho, "index.html")].map((c) => normalize(join(raiz, c))).find((c) => c.startsWith(raiz) && existsSync(c) && statSync(c).isFile());
    if (!achado) {
      res.writeHead(404);
      return res.end("não achei");
    }
    res.writeHead(200, { "content-type": TIPOS[extname(achado)] ?? "application/octet-stream" });
    createReadStream(achado).pipe(res);
  });
  return new Promise((ok) => http.listen(porta, "127.0.0.1", () => ok(http)));
}

let codigo = 1;
try {
  await admin(`drop database if exists "${BANCO}" with (force)`);
  await admin(`create database "${BANCO}"`);
  rodar("npm", ["run", "db:migrate", "-w", "@futbolsa/api"], { env: { ...process.env, DATABASE_URL: urlDoBanco } });
  rodar("npm", ["run", "build:libs"]);
  rodar("npm", ["run", "build", "-w", "@futbolsa/api"]);
  rodar("npm", ["run", "build", "-w", "@futbolsa/web"], {
    env: {
      ...process.env,
      NEXT_DIST_DIR: "out-supabase",
      NEXT_PUBLIC_SUPABASE_URL: process.env.SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY,
      NEXT_PUBLIC_API_URL: `http://127.0.0.1:${PORTA_API}`,
      NEXT_PUBLIC_AUTH_CLIENT: "",
    },
  });
  servidorSite = await servir(join(WEB, "out-supabase"), PORTA_SITE);
  const api = spawn(process.execPath, ["dist/main.js"], {
    cwd: API,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: urlDoBanco, PORT: String(PORTA_API), WEB_ORIGIN: `http://127.0.0.1:${PORTA_SITE}`, JOBS_ENABLED: "false", ADMIN_LOG_EMAIL_KEY: "chave-so-deste-roteiro-de-teste" },
  });
  filhos.push(api);
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORTA_API}/health`)).ok) break;
    } catch {
      /* ainda subindo */
    }
    await new Promise((ok) => setTimeout(ok, 1000));
  }
  const teste = spawnSync("npx", ["playwright", "test", "-c", "e2e/supabase/playwright.supabase.config.ts", ...process.argv.slice(2)], {
    cwd: WEB,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, E2E_SUPABASE_DATABASE_URL: urlDoBanco, E2E_SUPABASE_SITE: `http://127.0.0.1:${PORTA_SITE}` },
  });
  codigo = teste.status ?? 1;
} catch (erro) {
  console.error(String(erro));
} finally {
  await limpar();
}
process.exit(codigo);
