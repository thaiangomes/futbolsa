// Medição da trava da entrada no meio da temporada (Plano da entrada no meio da temporada, T5; Arquitetura da Fase 1,
// "Escala"). Não é teste automático: o tempo depende da máquina e da latência até o banco. Cria um banco próprio, monta
// uma temporada com 20 clubes e faz entradas em sequência, uma carteira índice e uma só caixa por vez, com uma latência
// simulada por comando SQL (o Supabase na nuvem fica a dezenas de milissegundos do servidor da API). Mede, por entrada, o
// tempo com TODOS os clubes travados: do `FOR UPDATE` dos clubes ao `COMMIT`.
//
//   TEST_DATABASE_URL=... node --import tsx apps/api/scripts/entry-lock-timing.mjs [entradas=12] [latências em ms=0,20,50,100]
//
// (o servidor de TEST_DATABASE_URL só ganha um banco `futbolsa_entry_timing_*`, apagado no fim; a URL nunca é impressa)
import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import pg from "pg";

const entries = Number(process.argv[2] ?? 12);
const latencies = (process.argv[3] ?? "0,20,50,100").split(",").map(Number);

const { connect } = await import("../src/infra/db/client.ts");
const { runMigrations } = await import("../src/infra/db/migrate.ts");
const { FixedClock } = await import("../src/infra/clock/index.ts");
const { PortfolioLedger } = await import("../src/modules/portfolio/index.ts");
const { EntryService } = await import("../src/modules/entry/enter.service.ts");
const { EntryGate } = await import("../src/modules/entry/entry-gate.ts");
const { EntryEvents } = await import("../src/modules/entry/events.ts");
const { entryWorld } = await import("../test/entry/support.ts");
const { createUser, T0 } = await import("../test/support/fixtures.ts");

const baseUrl = process.env.TEST_DATABASE_URL;
if (!baseUrl) throw new Error("defina TEST_DATABASE_URL (o Postgres dos testes)");
const withDatabase = (database) => {
  const u = new URL(baseUrl);
  u.pathname = `/${database}`;
  return u.toString();
};
async function admin(sql) {
  const client = new pg.Client({ connectionString: baseUrl });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pct = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const fmt = (values) => `p50 ${pct(values, 50).toFixed(0)} ms, p95 ${pct(values, 95).toFixed(0)} ms (n=${values.length})`;

// A latência é uma espera antes de cada comando; a janela vai do envio do `FOR UPDATE` dos clubes ao `COMMIT`.
let latency = 0;
let measuring = false;
let lockedAt = null;
let windows = [];
let commands = 0;
const originalQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function (...args) {
  if (!measuring || typeof args[args.length - 1] === "function") return originalQuery.apply(this, args);
  const text = typeof args[0] === "string" ? args[0] : (args[0]?.text ?? "");
  const isLock = /for update/i.test(text) && /season_clubs/.test(text);
  const isCommit = /^\s*commit\s*$/i.test(text);
  return (latency > 0 ? sleep(latency) : Promise.resolve())
    .then(() => {
      if (isLock) {
        lockedAt = performance.now();
        commands = 0;
      }
      if (lockedAt !== null) commands++;
      return originalQuery.apply(this, args);
    })
    .then((result) => {
      if (isCommit && lockedAt !== null) {
        windows.push({ ms: performance.now() - lockedAt, commands });
        lockedAt = null;
      }
      return result;
    });
};

const name = `futbolsa_entry_timing_${process.pid}_${randomBytes(3).toString("hex")}`;
await admin(`create database "${name}"`);
let conn;
try {
  const url = withDatabase(name);
  await runMigrations(url);
  conn = connect(url, 5);
  const db = conn.db;
  await entryWorld(db, { clubs: 20 });
  const service = new EntryService(db, new FixedClock(T0), new PortfolioLedger(), new EntryGate(), new EntryEvents({ publish() {} }));
  console.log(`${entries} entradas por latência, 20 clubes (metade índice, metade só caixa)`);
  for (const ms of latencies) {
    latency = ms;
    measuring = true;
    for (const mode of ["index", "cash"]) {
      windows = [];
      for (let i = 0; i < entries / 2; i++) {
        const userId = await createUser(db);
        await service.enter({ type: "user", userId, status: "active" }, mode);
      }
      const times = windows.map((w) => w.ms);
      console.log(
        `  latência ${String(ms).padStart(3)} ms, ${mode.padEnd(5)}: trava dos clubes ${fmt(times)}; ${windows[0]?.commands ?? "?"} comandos com a trava`,
      );
    }
  }
} finally {
  pg.Client.prototype.query = originalQuery;
  await conn?.close();
  await admin(`drop database if exists "${name}" with (force)`);
}
